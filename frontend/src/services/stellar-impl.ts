// Stellar SDK integration service
import { STELLAR_CONFIG, NETWORK_CONFIGS } from '../config/stellar'
import { walletService } from './wallet'
import { captureContractError } from '../lib/monitoring/sentry'
import type {
  AppError,
  ContractEvent,
  ContractEventType,
  DeploymentResult,
  FactoryState,
  GetEventsResult,
  TokenEventsResult,
  TokenInfo,
  TokenInfoResult,
} from '../types'
import {
  Account,
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Address,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
  FeeBumpTransaction,
  Transaction,
  StrKey,
} from 'stellar-sdk'
import type { Network } from '../config/stellar'
import { withRetry, HttpError } from '../utils/retry'
import { fetchAllContractEvents } from '../utils/fetchAllContractEvents'
import { parseContractError } from '../utils/contractErrors'
import { nextBackoffDelay } from '../utils/pollWithBackoff'

export type { FactoryState } from '../types'

// ── Utilities ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Invalid WASM hash: expected exactly 64 hex characters, got "${hex}"`)
  }
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Convert a raw error into the project's AppError shape. */
function toAppError(err: unknown): AppError {
  const parsed = parseContractError(err)
  return { code: 'CONTRACT_ERROR', message: parsed.message }
}

/**
 * Default page size for `getAllTokens` when a caller does not specify one.
 * Mirrors the Token Explorer / dashboard default so the first page maps to a
 * single index-range fetch.
 */
const DEFAULT_TOKEN_PAGE_LIMIT = 10

/**
 * Maximum number of `get_token_info` view calls kept in flight at once while
 * assembling one page of the global token list. The SDF publishes no static
 * RPC rate limit and throttles dynamically (see docs/rpc-rate-limits.md), so
 * we stay deliberately conservative — a single page never bursts more than
 * this many simultaneous simulations at the endpoint.
 */
const GET_ALL_TOKENS_CONCURRENCY = 5

/**
 * Resolve `tasks` with at most `limit` running concurrently, preserving input
 * order. Uses `Promise.allSettled` semantics: every task settles and the
 * caller decides how to treat rejections, so one failing index read never
 * rejects the whole batch.
 */
async function allSettledWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(tasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]!() }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length))
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

// ── Network helpers ───────────────────────────────────────────────────────────

function getNetworkConfig(network: Network) {
  return NETWORK_CONFIGS[network]
}

function getNetworkPassphrase(network: Network): string {
  if (network === 'mainnet') return Networks.PUBLIC
  if (network === 'testnet') return Networks.TESTNET
  return NETWORK_CONFIGS[network].networkPassphrase
}

function getRpcServer(network: Network): rpc.Server {
  return new rpc.Server(getNetworkConfig(network).sorobanRpcUrl, { allowHttp: false })
}

// ── Transaction lifecycle ─────────────────────────────────────────────────────

/**
 * Simulate, sign via Freighter, submit, and poll until confirmed.
 * Returns the transaction hash on success.
 *
 * Both simulation and submission are wrapped with retry logic so that
 * transient failures (including 429 rate-limit responses) are handled
 * with exponential backoff before the user sees an error.
 */
async function simulateAndSubmit(
  server: rpc.Server,
  tx: ReturnType<TransactionBuilder['build']>,
  network: Network,
): Promise<string> {
  const simResult = await withRetry(() => server.simulateTransaction(tx))

  if (rpc.Api.isSimulationError(simResult)) {
    throw parseContractError(new Error(simResult.error))
  }
  if (!rpc.Api.isSimulationSuccess(simResult)) {
    throw new Error('Transaction simulation returned an unexpected result')
  }

  const assembled = rpc.assembleTransaction(tx, simResult).build()
  const signedXdr = await walletService.signTransaction(assembled.toXDR(), network)

  const submitResult = await withRetry(() =>
    server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, getNetworkPassphrase(network))),
  )

  if (submitResult.status === 'ERROR') {
    throw parseContractError(
      new Error(submitResult.errorResult?.toXDR('base64') ?? 'Submission failed'),
    )
  }

  await pollTransaction(server, submitResult.hash)
  return submitResult.hash
}

async function pollTransaction(
  server: rpc.Server,
  hash: string,
  maxAttempts = 20,
  initialDelayMs = 500,
  maxDelayMs = 4_000,
): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = (await withRetry(() =>
      server.getTransaction(hash),
    )) as rpc.Api.GetTransactionResponse
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return result
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw parseContractError(new Error(`Transaction failed: ${hash}`))
    }
    const delay = nextBackoffDelay(i, { initialDelayMs, maxDelayMs })
    await new Promise((r) => setTimeout(r, delay))
  }
  throw new Error(`Transaction ${hash} timed out after ${maxAttempts} attempts`)
} // ── Fee Bump Transactions ─────────────────────────────────────────────────────

/**
 * Wrap a signed inner transaction in a fee bump envelope.
 * The fee-source account (connected via Freighter) signs the bump.
 */
export async function buildFeeBumpTransaction(
  innerTxXdr: string,
  feeSource: string,
  network: Network,
  baseFee: string = String(Number(BASE_FEE) * 10),
): Promise<string> {
  const networkPassphrase = getNetworkPassphrase(network)
  const innerTx = TransactionBuilder.fromXDR(innerTxXdr, networkPassphrase) as Transaction
  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    baseFee,
    innerTx,
    networkPassphrase,
  )
  return walletService.signTransaction(feeBumpTx.toXDR(), network)
}

/**
 * Submit a signed fee bump transaction and wait for confirmation.
 */
export async function submitFeeBumpTransaction(
  signedFeeBumpXdr: string,
  network: Network,
): Promise<string> {
  const server = getRpcServer(network)
  const feeBumpTx = TransactionBuilder.fromXDR(
    signedFeeBumpXdr,
    getNetworkPassphrase(network),
  ) as FeeBumpTransaction

  const submitResult = await withRetry(() => server.sendTransaction(feeBumpTx))
  if (submitResult.status === 'ERROR') {
    throw parseContractError(
      new Error(submitResult.errorResult?.toXDR('base64') ?? 'Fee bump submission failed'),
    )
  }
  await pollTransaction(server, submitResult.hash)
  return submitResult.hash
}

// ── Shared builder helper ─────────────────────────────────────────────────────

async function buildTxBuilder(
  server: rpc.Server,
  sourceAddress: string,
  network: Network,
): Promise<TransactionBuilder> {
  const account = await withRetry(() => server.getAccount(sourceAddress))
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(network),
  })
}

// ── View function helper ──────────────────────────────────────────────────────

/**
 * Call a read-only contract function via simulation (no signing required).
 */
async function callView(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourceAddress: string,
  network: Network,
): Promise<xdr.ScVal> {
  const contract = new Contract(contractId)
  const account = await withRetry(() => server.getAccount(sourceAddress))
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(network),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const simResult = await withRetry(() => server.simulateTransaction(tx))
  if (rpc.Api.isSimulationError(simResult)) {
    throw parseContractError(new Error(simResult.error))
  }
  if (!rpc.Api.isSimulationSuccess(simResult) || !simResult.result) {
    throw new Error(`View call to ${method} returned no result`)
  }
  return simResult.result.retval
}

/**
 * Approximate window (in days) that public Soroban RPC infrastructure retains
 * contract events for. `getEvents` cannot return events older than this, so any
 * event-derived history is inherently partial and must be disclosed as such
 * rather than presented as a token's complete lifetime. See
 * `docs/rpc-rate-limits.md` for the retention constraint.
 */
export const RPC_EVENT_RETENTION_DAYS = 7

/**
 * Placeholder source account for read-only view simulations. Soroban's
 * `simulateTransaction` does not require the source account to exist or be
 * funded for invocations that require no authorization, so token identity can
 * be resolved without a connected wallet. This is the canonical all-zero
 * ed25519 account (`StrKey.encodeEd25519PublicKey(new Uint8Array(32))`), a
 * valid — if unfunded — StrKey, hardcoded to avoid a Buffer dependency.
 */
const READONLY_SOURCE_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

/**
 * Call a read-only contract view via simulation without requiring a connected
 * wallet. Unlike {@link callView}, the source account is not fetched from the
 * network (a placeholder is used) so anonymous page loads can resolve token
 * data. The connected wallet address is used when available so simulations are
 * attributed to a real account, but it is never required.
 */
async function callViewReadonly(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  network: Network,
): Promise<xdr.ScVal> {
  const contract = new Contract(contractId)
  const source = walletService.getConnectedAddress() ?? READONLY_SOURCE_ACCOUNT
  // Sequence number is irrelevant for a read-only simulation; a locally
  // constructed account avoids an extra `getAccount` round-trip and works even
  // when `source` has never been funded on-chain.
  const account = new Account(source, '0')
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(network),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const simResult = await withRetry(() => server.simulateTransaction(tx))
  if (rpc.Api.isSimulationError(simResult)) {
    throw parseContractError(new Error(simResult.error))
  }
  if (!rpc.Api.isSimulationSuccess(simResult) || !simResult.result) {
    throw new Error(`View call to ${method} returned no result`)
  }
  return simResult.result.retval
}

// ── Raw RPC types ─────────────────────────────────────────────────────────────

export interface RpcEventResponse {
  id: string
  type: string
  ledger: number
  ledgerClosedAt: string
  contractId: string
  pagingToken: string
  inSuccessfulContractCall: boolean
  txHash: string
  topic: string[]
  value: string
}

interface RpcGetEventsResult {
  events: RpcEventResponse[]
  latestLedger: number
}

// ── XDR decode helper ─────────────────────────────────────────────────────────

function scValToString(val: xdr.ScVal | undefined): string {
  if (!val) return ''
  try {
    const type = val.switch()
    if (type === xdr.ScValType.scvAddress()) {
      const addr = val.address()
      if (addr.switch() === xdr.ScAddressType.scAddressTypeAccount()) {
        return StrKey.encodeEd25519PublicKey(addr.accountId().ed25519())
      }
      return Array.from(addr.contractId() as Uint8Array)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
    if (type === xdr.ScValType.scvI128()) {
      const hi = BigInt(val.i128().hi().toString())
      const lo = BigInt(val.i128().lo().toString())
      return ((hi << 64n) | lo).toString()
    }
    if (type === xdr.ScValType.scvU64()) return val.u64().toString()
    if (type === xdr.ScValType.scvString()) return val.str().toString()
    if (type === xdr.ScValType.scvSymbol()) return val.sym().toString()
    if (type === xdr.ScValType.scvBool()) return val.b().toString()
    if (type === xdr.ScValType.scvVoid()) return 'none'
    if (type === xdr.ScValType.scvVec()) {
      return (val.vec() ?? []).map((v) => scValToString(v)).join(', ')
    }
    return val.toXDR('base64')
  } catch {
    return ''
  }
}

// ── Event parsing ─────────────────────────────────────────────────────────────

/**
 * Single source of truth that maps every contract symbol_short! topic value to
 * its ContractEventType.  The allow-list and the parser both derive from this
 * table, so they can never drift apart.
 *
 * Contract topics are verified against lib.rs symbol_short! calls by
 * scripts/check-event-topic-drift.sh (CI).  If you add a new event to the
 * contract, add it here first — the CI script will catch any omission.
 *
 * Audit of all twelve contract topics (lib.rs → frontend):
 *   init      → 'init'      (factory init)
 *   created   → 'created'   (token deployed)
 *   meta      → 'meta'      (metadata URI set)
 *   mint      → 'mint'      (tokens minted)
 *   burn      → 'burn'      (tokens burned)
 *   fees      → 'fees'      (fees updated)
 *   pause     → 'pause'     (factory paused)
 *   unpause   → 'unpause'   (factory unpaused)
 *   adm_upd   → 'adm_upd'  (admin rotated)  ← was incorrectly 'admin_update'
 *   wl_add    → 'wl_add'   (address added to whitelist)
 *   wl_rm     → 'wl_rm'    (address removed from whitelist)
 *   wl_tog    → 'wl_tog'   (whitelist enforcement toggled)
 */
export const CONTRACT_TOPIC_MAP: Record<string, ContractEventType> = {
  init: 'init',
  created: 'created',
  meta: 'meta',
  mint: 'mint',
  burn: 'burn',
  fees: 'fees',
  pause: 'pause',
  unpause: 'unpause',
  adm_upd: 'adm_upd',
  wl_add: 'wl_add',
  wl_rm: 'wl_rm',
  wl_tog: 'wl_tog',
} as const

/** Allow-list of recognised event types, derived from CONTRACT_TOPIC_MAP. */
const EVENT_TOPICS = new Set<string>(Object.keys(CONTRACT_TOPIC_MAP))

export async function parseRpcEvent(raw: RpcEventResponse): Promise<ContractEvent | null> {
  try {
    if (!raw.topic?.length || raw.topic.length < 2) return null
    const topicVal = xdr.ScVal.fromXDR(raw.topic[1]!, 'base64') // second topic is the action
    const rawTopic = scValToString(topicVal)
    if (!EVENT_TOPICS.has(rawTopic)) return null
    const eventType = CONTRACT_TOPIC_MAP[rawTopic]!

    const items: xdr.ScVal[] = xdr.ScVal.fromXDR(raw.value, 'base64').vec() ?? []
    const data: Record<string, string> = {}

    switch (eventType) {
      case 'init':
        data.admin = scValToString(items[0])
        break
      case 'created':
        data.tokenAddress = scValToString(items[0])
        data.creator = scValToString(items[1])
        data.name = scValToString(items[2])
        data.symbol = scValToString(items[3])
        break
      case 'meta':
        data.tokenAddress = scValToString(items[0])
        data.metadataUri = scValToString(items[1])
        break
      case 'mint':
        data.tokenAddress = scValToString(items[0])
        data.to = scValToString(items[1])
        data.amount = scValToString(items[2])
        break
      case 'burn':
        data.tokenAddress = scValToString(items[0])
        data.from = scValToString(items[1])
        data.amount = scValToString(items[2])
        break
      case 'fees':
        data.baseFee = scValToString(items[0])
        data.metadataFee = scValToString(items[1])
        break
      case 'pause':
        data.admin = scValToString(items[0])
        break
      case 'unpause':
        data.admin = scValToString(items[0])
        break
      case 'adm_upd':
        data.currentAdmin = scValToString(items[0])
        data.newAdmin = scValToString(items[1])
        break
      case 'wl_add':
        data.address = scValToString(items[0])
        break
      case 'wl_rm':
        data.address = scValToString(items[0])
        break
      case 'wl_tog':
        data.enabled = scValToString(items[0])
        break
    }

    return {
      id: raw.id,
      type: eventType,
      ledger: raw.ledger,
      timestamp: raw.ledgerClosedAt ? Math.floor(new Date(raw.ledgerClosedAt).getTime() / 1000) : 0,
      txHash: raw.txHash,
      data,
    }
  } catch {
    return null
  }
}

// ── JSON-RPC helper ───────────────────────────────────────────────────────────

async function rpcCall<T>(method: string, params: unknown, network: Network): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(getNetworkConfig(network).sorobanRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) {
      const retryAfter = res.headers.get('Retry-After')
      throw new HttpError(
        res.status,
        `RPC HTTP error ${res.status}`,
        retryAfter ? parseInt(retryAfter, 10) : undefined,
      )
    }
    const json = await res.json()
    if (json.error) {
      const errorMsg: string = json.error.message ?? 'RPC error'
      if (errorMsg.toLowerCase().includes('rate limit')) throw new HttpError(429, errorMsg)
      throw new Error(errorMsg)
    }
    return json.result as T
  })
}

// ── StellarService ────────────────────────────────────────────────────────────

export class StellarService {
  private network: Network

  constructor(network: Network = 'testnet') {
    this.network = network
  }

  setNetwork(network: Network) {
    this.network = network
  }

  // ── deployToken ─────────────────────────────────────────────────────────────

  /**
   * Build and submit a `create_token` invocation to the factory contract.
   * Waits for transaction inclusion and returns the new contract ID.
   */
  async deployToken(params: {
    name: string
    symbol: string
    decimals: number
    initialSupply: string
    salt: string
    feePayment: string
  }): Promise<DeploymentResult> {
    const functionName = 'deployToken'
    try {
      const contractId = STELLAR_CONFIG.factoryContractId
      if (!contractId) throw new Error('Factory contract ID is not configured')

      const sourceAddress = walletService.getConnectedAddress()
      if (!sourceAddress) throw new Error('Wallet not connected')

      const server = getRpcServer(this.network)
      const contract = new Contract(contractId)

      const tx = (await buildTxBuilder(server, sourceAddress, this.network))
        .addOperation(
          contract.call(
            'create_token',
            new Address(sourceAddress).toScVal(),
            nativeToScVal(hexToBytes(params.salt), { type: 'bytes' }),
            nativeToScVal(params.name, { type: 'string' }),
            nativeToScVal(params.symbol, { type: 'string' }),
            nativeToScVal(params.decimals, { type: 'u32' }),
            nativeToScVal(BigInt(params.initialSupply), { type: 'u128' }),
            nativeToScVal(BigInt(params.feePayment), { type: 'i128' }),
          ),
        )
        .setTimeout(30)
        .build()

      const hash = await simulateAndSubmit(server, tx, this.network)

      // Extract the returned token address from the transaction result
      const txResult = await withRetry(() => server.getTransaction(hash))
      let tokenAddress = ''
      if (txResult.status === rpc.Api.GetTransactionStatus.SUCCESS && txResult.returnValue) {
        tokenAddress = scValToNative(txResult.returnValue) as string
      }

      return { tokenAddress, transactionHash: hash, success: true }
    } catch (err) {
      const appErr = toAppError(err)
      const factoryContractId = STELLAR_CONFIG.factoryContractId ?? 'unknown'
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId: factoryContractId,
        functionName,
        params: { name: params.name, symbol: params.symbol, decimals: params.decimals },
      })
      throw new Error(appErr.message)
    }
  }

  // ── mintTokens ──────────────────────────────────────────────────────────────

  /**
   * Invoke `mint_tokens` on the factory contract for the given token address.
   * `amount` and `feePayment` are decimal string representations of i128 values.
   */
  async mintTokens(params: {
    tokenAddress: string
    to: string
    amount: string
    feePayment: string
  }): Promise<string> {
    const functionName = 'mintTokens'
    try {
      const contractId = STELLAR_CONFIG.factoryContractId
      if (!contractId) throw new Error('Factory contract ID is not configured')

      const sourceAddress = walletService.getConnectedAddress()
      if (!sourceAddress) throw new Error('Wallet not connected')

      const server = getRpcServer(this.network)
      const contract = new Contract(contractId)

      const tx = (await buildTxBuilder(server, sourceAddress, this.network))
        .addOperation(
          contract.call(
            'mint_tokens',
            new Address(params.tokenAddress).toScVal(), // token_address
            new Address(sourceAddress).toScVal(), // admin (caller)
            new Address(params.to).toScVal(), // to
            nativeToScVal(BigInt(params.amount), { type: 'i128' }),
            nativeToScVal(BigInt(params.feePayment), { type: 'i128' }),
          ),
        )
        .setTimeout(30)
        .build()

      return await simulateAndSubmit(server, tx, this.network)
    } catch (err) {
      const appErr = toAppError(err)
      const factoryContractId = STELLAR_CONFIG.factoryContractId ?? 'unknown'
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId: factoryContractId,
        functionName,
        params: { tokenAddress: params.tokenAddress, amount: params.amount },
      })
      throw new Error(appErr.message)
    }
  }

  // ── burnTokens ──────────────────────────────────────────────────────────────

  /**
   * Invoke `burn` on the factory contract.
   * `amount` is a decimal string representation of an i128 value.
   */
  async burnTokens(params: { tokenAddress: string; amount: string }): Promise<string> {
    const functionName = 'burnTokens'
    try {
      const contractId = STELLAR_CONFIG.factoryContractId
      if (!contractId) throw new Error('Factory contract ID is not configured')

      const sourceAddress = walletService.getConnectedAddress()
      if (!sourceAddress) throw new Error('Wallet not connected')

      const server = getRpcServer(this.network)
      const contract = new Contract(contractId)

      const tx = (await buildTxBuilder(server, sourceAddress, this.network))
        .addOperation(
          contract.call(
            'burn',
            new Address(params.tokenAddress).toScVal(), // token_address
            new Address(sourceAddress).toScVal(), // from (caller)
            nativeToScVal(BigInt(params.amount), { type: 'i128' }),
          ),
        )
        .setTimeout(30)
        .build()

      return await simulateAndSubmit(server, tx, this.network)
    } catch (err) {
      const appErr = toAppError(err)
      const factoryContractId = STELLAR_CONFIG.factoryContractId ?? 'unknown'
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId: factoryContractId,
        functionName,
        params: { tokenAddress: params.tokenAddress, amount: params.amount },
      })
      throw new Error(appErr.message)
    }
  }

  // ── setMetadata ─────────────────────────────────────────────────────────────

  /**
   * Invoke `set_metadata` on the factory contract.
   * `feePayment` is a decimal string representation of an i128 value.
   */
  async setMetadata(params: {
    tokenAddress: string
    metadataUri: string
    feePayment: string
  }): Promise<string> {
    const functionName = 'setMetadata'
    try {
      const contractId = STELLAR_CONFIG.factoryContractId
      if (!contractId) throw new Error('Factory contract ID is not configured')

      const sourceAddress = walletService.getConnectedAddress()
      if (!sourceAddress) throw new Error('Wallet not connected')

      const server = getRpcServer(this.network)
      const contract = new Contract(contractId)

      const tx = (await buildTxBuilder(server, sourceAddress, this.network))
        .addOperation(
          contract.call(
            'set_metadata',
            new Address(params.tokenAddress).toScVal(), // token_address
            new Address(sourceAddress).toScVal(), // admin (caller)
            nativeToScVal(params.metadataUri, { type: 'string' }),
            nativeToScVal(BigInt(params.feePayment), { type: 'i128' }),
          ),
        )
        .setTimeout(30)
        .build()

      return await simulateAndSubmit(server, tx, this.network)
    } catch (err) {
      const appErr = toAppError(err)
      const factoryContractId = STELLAR_CONFIG.factoryContractId ?? 'unknown'
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId: factoryContractId,
        functionName,
        params: { tokenAddress: params.tokenAddress, metadataUri: params.metadataUri },
      })
      throw new Error(appErr.message)
    }
  }

  // ── getTokenInfo ────────────────────────────────────────────────────────────

  /**
   * Perform a read-only RPC simulation of `get_token_info` on the factory
   * contract and map the response to the local TokenInfo interface.
   */
  async getTokenInfo(index: number): Promise<TokenInfo> {
    const functionName = 'getTokenInfo'
    const contractId = STELLAR_CONFIG.factoryContractId
    if (!contractId) throw new Error('Factory contract ID is not configured')

    const sourceAddress = walletService.getConnectedAddress()
    if (!sourceAddress) throw new Error('Wallet not connected')

    try {
      const server = getRpcServer(this.network)
      const retval = await callView(
        server,
        contractId,
        'get_token_info',
        [nativeToScVal(index, { type: 'u32' })],
        sourceAddress,
        this.network,
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const native = scValToNative(retval) as any
      return {
        name: String(native.name ?? ''),
        symbol: String(native.symbol ?? ''),
        decimals: Number(native.decimals ?? 7),
        creator: native.creator?.toString() ?? '',
        createdAt: Number(native.created_at ?? 0),
        totalSupply: native.total_supply?.toString(),
      }
    } catch (err) {
      const appErr = toAppError(err)
      const factoryContractId = STELLAR_CONFIG.factoryContractId ?? 'unknown'
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId: factoryContractId,
        functionName,
        params: { index },
      })
      throw new Error(appErr.message)
    }
  }

  // ── getTransaction ──────────────────────────────────────────────────────────

  /**
   * Fetch transaction details from the Horizon server using the transaction hash.
   */
  async getTransaction(hash: string): Promise<Record<string, unknown>> {
    const functionName = 'getTransaction'
    try {
      return await withRetry(async () => {
        const { horizonUrl } = getNetworkConfig(this.network)
        const res = await fetch(`${horizonUrl}/transactions/${hash}`)
        if (!res.ok) {
          if (res.status === 404) throw new Error(`Transaction not found: ${hash}`)
          const retryAfter = res.headers.get('Retry-After')
          throw new HttpError(
            res.status,
            `Horizon error ${res.status}`,
            retryAfter ? parseInt(retryAfter, 10) : undefined,
          )
        }
        return res.json() as Promise<Record<string, unknown>>
      })
    } catch (err) {
      const appErr = toAppError(err)
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        functionName,
        txHash: hash,
        params: { hash },
      })
      throw new Error(appErr.message)
    }
  }

  async getFactoryState(): Promise<FactoryState> {
    const functionName = 'getFactoryState'
    const contractId = STELLAR_CONFIG.factoryContractId
    if (!contractId) throw new Error('Factory contract ID is not configured')

    const sourceAddress = walletService.getConnectedAddress()
    if (!sourceAddress) throw new Error('Wallet not connected')

    try {
      const server = getRpcServer(this.network)
      const retval = await callView(
        server,
        contractId,
        'get_state',
        [],
        sourceAddress,
        this.network,
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const native = scValToNative(retval) as any
      return {
        admin: native.admin?.toString() ?? '',
        paused: Boolean(native.paused),
        treasury: native.treasury?.toString() ?? '',
        baseFee: native.base_fee?.toString() ?? '0',
        metadataFee: native.metadata_fee?.toString() ?? '0',
        tokenCount: Number(native.token_count ?? 0),
        whitelistEnabled: Boolean(native.whitelist_enabled ?? false),
        // scValToNative turns BytesN<32> into a Buffer/Uint8Array — normalise
        // to lowercase hex so it is directly comparable to VITE_TOKEN_WASM_HASH.
        tokenWasmHash: native.token_wasm_hash
          ? [...new Uint8Array(native.token_wasm_hash)]
              .map((b: number) => b.toString(16).padStart(2, '0'))
              .join('')
          : undefined,
      }
    } catch (err) {
      const appErr = toAppError(err)
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId,
        functionName,
      })
      throw new Error(appErr.message)
    }
  }

  // ── accountExists ───────────────────────────────────────────────────────────

  async accountExists(address: string): Promise<boolean> {
    return withRetry(async () => {
      const { horizonUrl } = getNetworkConfig(this.network)
      const res = await fetch(`${horizonUrl}/accounts/${address}`)
      if (res.status === 404) return false
      if (!res.ok) {
        const retryAfter = res.headers.get('Retry-After')
        throw new HttpError(
          res.status,
          `Horizon error ${res.status}`,
          retryAfter ? parseInt(retryAfter, 10) : undefined,
        )
      }
      return true
    })
  }

  // ── updateFees ──────────────────────────────────────────────────────────────

  async updateFees(params: { baseFee: string; metadataFee: string }): Promise<string> {
    const functionName = 'updateFees'
    try {
      const contractId = STELLAR_CONFIG.factoryContractId
      if (!contractId) throw new Error('Factory contract ID is not configured')

      const sourceAddress = walletService.getConnectedAddress()
      if (!sourceAddress) throw new Error('Wallet not connected')

      const server = getRpcServer(this.network)
      const contract = new Contract(contractId)

      // Contract expects Option<i128> — wrap each value in Some(i128)
      const someI128 = (v: bigint) =>
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Some'), nativeToScVal(v, { type: 'i128' })])

      const tx = (await buildTxBuilder(server, sourceAddress, this.network))
        .addOperation(
          contract.call(
            'update_fees',
            new Address(sourceAddress).toScVal(),
            someI128(BigInt(params.baseFee)),
            someI128(BigInt(params.metadataFee)),
          ),
        )
        .setTimeout(30)
        .build()

      return await simulateAndSubmit(server, tx, this.network)
    } catch (err) {
      const appErr = toAppError(err)
      const factoryContractId = STELLAR_CONFIG.factoryContractId ?? 'unknown'
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId: factoryContractId,
        functionName,
        params: { baseFee: params.baseFee, metadataFee: params.metadataFee },
      })
      throw new Error(appErr.message)
    }
  }

  // ── setWhitelistEnabled ──────────────────────────────────────────────────────

  /**
   * Invoke `set_whitelist_enabled` on the factory contract.
   * When `enabled` is true, only whitelisted addresses may call
   * `create_token` / `create_tokens_batch`.
   */
  async setWhitelistEnabled(enabled: boolean): Promise<string> {
    const functionName = 'setWhitelistEnabled'
    try {
      const contractId = STELLAR_CONFIG.factoryContractId
      if (!contractId) throw new Error('Factory contract ID is not configured')

      const sourceAddress = walletService.getConnectedAddress()
      if (!sourceAddress) throw new Error('Wallet not connected')

      const server = getRpcServer(this.network)
      const contract = new Contract(contractId)

      const tx = (await buildTxBuilder(server, sourceAddress, this.network))
        .addOperation(
          contract.call(
            'set_whitelist_enabled',
            new Address(sourceAddress).toScVal(),
            nativeToScVal(enabled, { type: 'bool' }),
          ),
        )
        .setTimeout(30)
        .build()

      return await simulateAndSubmit(server, tx, this.network)
    } catch (err) {
      const appErr = toAppError(err)
      const factoryContractId = STELLAR_CONFIG.factoryContractId ?? 'unknown'
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId: factoryContractId,
        functionName,
        params: { enabled },
      })
      throw new Error(appErr.message)
    }
  }

  // ── getContractEvents ───────────────────────────────────────────────────────

  async getContractEvents(
    contractId: string,
    limit = 20,
    cursor?: string,
  ): Promise<GetEventsResult> {
    const params: Record<string, unknown> = {
      filters: [{ type: 'contract', contractIds: [contractId] }],
      pagination: { limit, ...(cursor ? { cursor } : {}) },
    }

    const result = await rpcCall<RpcGetEventsResult>('getEvents', params, this.network)
    const parsed = await Promise.all(result.events.map(parseRpcEvent))
    const events = parsed
      .filter((e): e is ContractEvent => e !== null)
      .sort((a, b) => b.ledger - a.ledger)

    const lastEvent = result.events[result.events.length - 1]
    return { events, cursor: lastEvent?.pagingToken ?? null }
  }

  // ── getAllTokens ─────────────────────────────────────────────────────────────

  /**
   * Fetch a page of the global token list, newest-first.
   *
   * The factory exposes no `get_all_tokens` view, but it maintains a
   * monotonically increasing `token_count` and stores every token at a 1-based
   * index (`TokenInfo(1..=token_count)`), readable via `get_token_info(index)`.
   * We page over that index range instead of walking event history.
   *
   * `offset`/`limit` describe a newest-first window: `offset = 0` starts at the
   * most-recently-created token (index `total`) and walks down toward index 1.
   * Index reads are issued with bounded concurrency
   * (`GET_ALL_TOKENS_CONCURRENCY`) to respect RPC rate limits
   * (docs/rpc-rate-limits.md) and collected with `Promise.allSettled` semantics
   * so a single transiently-missing index does not fail the whole page.
   *
   * Returns `{ tokens, total }` where `total` is the factory's `token_count`.
   * Callers MUST use `total` (not `tokens.length`) to distinguish "factory has
   * zero tokens" from "this page failed" — a short/empty page is never on its
   * own a truthful "no tokens exist" signal.
   *
   * Throws when the factory state cannot be read, or when a non-empty index
   * window was requested but *every* index read failed — so consumers render an
   * error state rather than a fake-empty list.
   */
  async getAllTokens(
    offset = 0,
    limit = DEFAULT_TOKEN_PAGE_LIMIT,
  ): Promise<{ tokens: TokenInfo[]; total: number }> {
    const contractId = STELLAR_CONFIG.factoryContractId
    if (!contractId) throw new Error('Factory contract ID is not configured')

    const { tokenCount } = await this.getFactoryState()
    const total = Math.max(0, tokenCount)
    if (total === 0 || limit <= 0) return { tokens: [], total }

    // Newest-first window over the 1-based index range [1, total].
    const highIndex = total - Math.max(0, offset)
    if (highIndex < 1) return { tokens: [], total } // offset past the oldest token
    const lowIndex = Math.max(1, highIndex - limit + 1)

    const indices: number[] = []
    for (let i = highIndex; i >= lowIndex; i--) indices.push(i)

    const settled = await allSettledWithConcurrency(
      indices.map((index) => () => this.getTokenInfo(index)),
      GET_ALL_TOKENS_CONCURRENCY,
    )

    // `settled[k]` corresponds to `indices[k]`; stamp the resolved 1-based
    // index onto each token so consumers can correlate it (e.g. to a token
    // address derived from `created` events, the complementary path).
    const tokens: TokenInfo[] = []
    settled.forEach((r, k) => {
      if (r.status === 'fulfilled') tokens.push({ ...r.value, index: indices[k]! })
    })

    // A non-empty window that resolved nothing is a fetch failure, not an
    // empty factory — surface it so the UI never shows a fake-empty list.
    if (tokens.length === 0) {
      const firstRejection = settled.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      )
      throw firstRejection?.reason instanceof Error
        ? firstRejection.reason
        : new Error('Failed to fetch any tokens for the requested page')
    }

    return { tokens, total }
  }

  // ── getTokensByCreator ───────────────────────────────────────────────────────

  /**
   * Fetch a paginated slice of tokens created by `creator`.
   *
   * This calls the contract's `get_tokens_by_creator` view function with the
   * supplied `offset` and `limit`, then resolves each returned index to a
   * full `TokenInfo` via `get_token_info`. Failed index lookups are skipped
   * (the page may end up smaller than `limit` when one token's metadata is
   * temporarily unavailable).
   *
   * The contract caps the `limit` it will service per call to keep responses
   * below Stellar ledger entry size limits, so callers should treat responses
   * shorter than `limit` as "end of available data" and stop iterating.
   */
  async getTokensByCreator(creator: string, offset: number, limit: number): Promise<TokenInfo[]> {
    const contractId = STELLAR_CONFIG.factoryContractId
    if (!contractId) throw new Error('Factory contract ID is not configured')

    const sourceAddress = walletService.getConnectedAddress()
    if (!sourceAddress) throw new Error('Wallet not connected')

    try {
      const server = getRpcServer(this.network)
      const indicesRetval = await callView(
        server,
        contractId,
        'get_tokens_by_creator',
        [
          new Address(creator).toScVal(),
          nativeToScVal(offset, { type: 'u32' }),
          nativeToScVal(limit, { type: 'u32' }),
        ],
        sourceAddress,
        this.network,
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const native = scValToNative(indicesRetval) as any
      const indices: number[] = Array.isArray(native) ? native.map((v: unknown) => Number(v)) : []

      if (indices.length === 0) return []

      const results = await Promise.allSettled(indices.map((i) => this.getTokenInfo(i)))
      return results
        .filter((r): r is PromiseFulfilledResult<TokenInfo> => r.status === 'fulfilled')
        .map((r) => r.value)
    } catch (err) {
      const appErr = toAppError(err)
      const factoryContractId = STELLAR_CONFIG.factoryContractId ?? 'unknown'
      captureContractError(err instanceof Error ? err : new Error(String(err)), {
        network: this.network,
        contractId: factoryContractId,
        functionName: 'getTokensByCreator',
        params: { creator, offset, limit },
      })
      throw new Error(appErr.message)
    }
  }

  // ── Address-keyed contract views ─────────────────────────────────────────────

  /**
   * Read a token's authoritative `TokenInfo` by contract address via the
   * on-chain `get_token_info_by_address` view.
   *
   * This is the source of truth for a token's name, symbol, decimals, creator
   * and creation time — unlike factory events, on-chain state has no retention
   * window, so a token created arbitrarily long ago still resolves correctly.
   * Throws (mapped to a `Token not found` error) when the address is not
   * registered with the factory.
   */
  async getTokenInfoByAddressView(tokenAddress: string): Promise<TokenInfo> {
    const contractId = STELLAR_CONFIG.factoryContractId
    if (!contractId) throw new Error('Factory contract ID is not configured')

    const server = getRpcServer(this.network)
    const retval = await callViewReadonly(
      server,
      contractId,
      'get_token_info_by_address',
      [new Address(tokenAddress).toScVal()],
      this.network,
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native = scValToNative(retval) as any
    return {
      name: String(native.name ?? ''),
      symbol: String(native.symbol ?? ''),
      // Decimals come straight from contract state — never a guessed default.
      decimals: Number(native.decimals ?? 0),
      creator: native.creator?.toString() ?? '',
      createdAt: Number(native.created_at ?? 0),
    }
  }

  /**
   * Read a token's current metadata URI from the on-chain `get_metadata` view.
   * Returns an empty string when no metadata has been set. Resolving from
   * contract state avoids scanning `meta` events, which are subject to RPC
   * retention truncation.
   */
  async getTokenMetadataUri(tokenAddress: string): Promise<string> {
    const contractId = STELLAR_CONFIG.factoryContractId
    if (!contractId) throw new Error('Factory contract ID is not configured')

    const server = getRpcServer(this.network)
    const retval = await callViewReadonly(
      server,
      contractId,
      'get_metadata',
      [new Address(tokenAddress).toScVal()],
      this.network,
    )
    const native = scValToNative(retval)
    return native == null ? '' : String(native)
  }

  // ── resolveTokenInfoByAddress ────────────────────────────────────────────────

  /**
   * Resolve a token's identity by address, returning a typed result rather than
   * ever fabricating a placeholder. Identity is read from the contract (see
   * {@link getTokenInfoByAddressView}), so `decimals` and the rest are always
   * authoritative when `status === 'resolved'`.
   *
   * When the factory has no such token (`not-found`) or cannot be reached
   * (`rpc-error`) the caller gets an explicit `unresolved` marker to render as
   * such — this is what prevents wrong decimals or an address-as-name from ever
   * being shown as if they were real token data.
   */
  async resolveTokenInfoByAddress(tokenAddress: string): Promise<TokenInfoResult> {
    try {
      const info = await this.getTokenInfoByAddressView(tokenAddress)

      let metadataUri = ''
      try {
        metadataUri = await this.getTokenMetadataUri(tokenAddress)
      } catch {
        // Metadata is non-critical; identity is already resolved. A failure
        // here (e.g. transient RPC error) must not downgrade a resolved token
        // to unresolved.
      }

      return { status: 'resolved', ...info, metadataUri }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const notFound = /token not found/i.test(message) || /Error\(Contract,\s*4\)/.test(message)
      return {
        status: 'unresolved',
        address: tokenAddress,
        reason: notFound ? 'not-found' : 'rpc-error',
        message: notFound
          ? `No token is registered at ${tokenAddress} with the factory contract.`
          : `Could not resolve token ${tokenAddress}: ${message}`,
      }
    }
  }

  // ── getTokenInfoByAddress ────────────────────────────────────────────────────

  /**
   * Throwing convenience wrapper over {@link resolveTokenInfoByAddress} for
   * callers that treat a rejection as "not found" (`TokenExplorer`, `useTokens`
   * filter the entry out). Prefer `resolveTokenInfoByAddress` where the UI can
   * render the `unresolved` state explicitly.
   */
  async getTokenInfoByAddress(tokenAddress: string): Promise<TokenInfo> {
    const result = await this.resolveTokenInfoByAddress(tokenAddress)
    if (result.status === 'unresolved') {
      throw new Error(
        result.reason === 'not-found'
          ? `No token found at address ${tokenAddress}`
          : result.message,
      )
    }
    const { status: _status, ...info } = result
    return info
  }

  /**
   * Get the complete available event history for a specific token address.
   *
   * Pages exhaustively through the factory's event stream via
   * {@link fetchAllContractEvents} (rather than a single fixed-size page, which
   * silently truncated a token's history to whatever happened most recently)
   * and filters to events referencing `tokenAddress`.
   *
   * The result is always flagged `retentionLimited`: Soroban RPC only retains
   * events for a bounded window (~{@link RPC_EVENT_RETENTION_DAYS} days on
   * public infrastructure), so events older than that cannot be served and the
   * list must never be presented as the token's complete lifetime. The UI
   * discloses this boundary rather than implying completeness.
   */
  async getTokenEvents(tokenAddress: string): Promise<TokenEventsResult> {
    const contractId = STELLAR_CONFIG.factoryContractId
    if (!contractId) {
      return {
        events: [],
        retentionLimited: true,
        retentionDays: RPC_EVENT_RETENTION_DAYS,
        cursor: null,
      }
    }

    const all = await fetchAllContractEvents(this, contractId)
    const events = all
      .filter((event) => event.data.tokenAddress === tokenAddress)
      .sort((a, b) => b.ledger - a.ledger)

    return {
      events,
      retentionLimited: true,
      retentionDays: RPC_EVENT_RETENTION_DAYS,
      cursor: null,
    }
  }
}

export const stellarService = new StellarService()
