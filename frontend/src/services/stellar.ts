// Stellar SDK integration service
import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from 'stellar-sdk'
import { STELLAR_CONFIG } from '../config/stellar'
import type { ContractEvent, ContractEventType, DeploymentResult, GetEventsResult } from '../types'

const EVENT_TOPICS: ContractEventType[] = [
  'token_created',
  'tokens_minted',
  'tokens_burned',
  'metadata_set',
  'fees_updated',
]

function getRpcUrl(): string {
  const network = STELLAR_CONFIG.network as 'testnet' | 'mainnet'
  return STELLAR_CONFIG[network].sorobanRpcUrl
}

// ── Factory contract read calls ──────────────────────────────────────────────

interface FactoryState {
  token_count: number
}

export interface FactoryTokenInfo {
  index: number
  name: string
  symbol: string
  decimals: number
  creator: string
  createdAt: number
  tokenAddress: string
}

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return Number(value)
  return 0
}

const toStringValue = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'toString' in value) {
    return String(value)
  }
  return ''
}

const getNetworkPassphrase = (): string =>
  STELLAR_CONFIG.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET

const getExplorerBaseUrl = (): string =>
  STELLAR_CONFIG.network === 'mainnet'
    ? 'https://stellar.expert/explorer/public'
    : 'https://stellar.expert/explorer/testnet'

// ── Raw RPC types ────────────────────────────────────────────────────────────

interface RpcEventResponse {
  id: string
  type: string
  ledger: number
  ledgerClosedAt: string
  contractId: string
  pagingToken: string
  inSuccessfulContractCall: boolean
  txHash: string
  topic: string[]   // base64-encoded XDR ScVal[]
  value: string     // base64-encoded XDR ScVal
}

interface RpcGetEventsResult {
  events: RpcEventResponse[]
  latestLedger: number
}

// ── XDR decode helpers (no SDK dependency) ───────────────────────────────────

/**
 * Decode a base64 XDR ScVal to a human-readable string.
 * We use the stellar-sdk xdr module dynamically so the service still compiles
 * even if types aren't resolved at edit time.
 */
async function scValB64ToString(b64: string): Promise<string> {
  try {
    // Dynamic import keeps the bundle tree-shakeable and avoids top-level type issues
    const { xdr } = await import('stellar-sdk')
    const val = xdr.ScVal.fromXDR(b64, 'base64')
    return scValToString(val, xdr)
  } catch {
    return b64
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scValToString(val: any, xdrNs: any): string {
  try {
    const type = val.switch()
    if (type === xdrNs.ScValType.scvAddress()) {
      const addr = val.address()
      if (addr.switch() === xdrNs.ScAddressType.scAddressTypeAccount()) {
        return addr.accountId().publicKey().toString()
      }
      return Buffer.from(addr.contractId()).toString('hex')
    }
    if (type === xdrNs.ScValType.scvI128()) {
      const hi = BigInt(val.i128().hi().toString())
      const lo = BigInt(val.i128().lo().toString())
      return ((hi << 64n) | lo).toString()
    }
    if (type === xdrNs.ScValType.scvU64()) return val.u64().toString()
    if (type === xdrNs.ScValType.scvString()) return val.str().toString()
    if (type === xdrNs.ScValType.scvSymbol()) return val.sym().toString()
    if (type === xdrNs.ScValType.scvVoid()) return 'none'
    if (type === xdrNs.ScValType.scvVec()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: string[] = (val.vec() ?? []).map((v: any) => scValToString(v, xdrNs))
      return items.join(', ')
    }
    return b64ToString(val.toXDR('base64'))
  } catch {
    return ''
  }
}

function b64ToString(b64: string): string {
  try {
    return atob(b64)
  } catch {
    return b64
  }
}

// ── Event parsing ─────────────────────────────────────────────────────────────

async function parseRpcEvent(raw: RpcEventResponse): Promise<ContractEvent | null> {
  try {
    if (!raw.topic?.length) return null

    // topic[0] is the event name symbol
    const eventType = (await scValB64ToString(raw.topic[0])) as ContractEventType
    if (!EVENT_TOPICS.includes(eventType)) return null

    const { xdr } = await import('stellar-sdk')
    const valueVal = xdr.ScVal.fromXDR(raw.value, 'base64')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = valueVal.vec() ?? []

    const data: Record<string, string> = {}

    switch (eventType) {
      case 'token_created':
        data.tokenAddress = scValToString(items[0], xdr)
        data.creator = scValToString(items[1], xdr)
        break
      case 'tokens_minted':
        data.tokenAddress = scValToString(items[0], xdr)
        data.to = scValToString(items[1], xdr)
        data.amount = scValToString(items[2], xdr)
        break
      case 'tokens_burned':
        data.tokenAddress = scValToString(items[0], xdr)
        data.from = scValToString(items[1], xdr)
        data.amount = scValToString(items[2], xdr)
        break
      case 'metadata_set':
        data.tokenAddress = scValToString(items[0], xdr)
        data.metadataUri = scValToString(items[1], xdr)
        break
      case 'fees_updated':
        data.baseFee = scValToString(items[0], xdr)
        data.metadataFee = scValToString(items[1], xdr)
        break
    }

    return {
      id: raw.id,
      type: eventType,
      ledger: raw.ledger,
      timestamp: raw.ledgerClosedAt
        ? Math.floor(new Date(raw.ledgerClosedAt).getTime() / 1000)
        : 0,
      txHash: raw.txHash,
      data,
    }
  } catch {
    return null
  }
}

// ── JSON-RPC helper ───────────────────────────────────────────────────────────

async function rpcCall<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(getRpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC HTTP error ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(json.error.message ?? 'RPC error')
  return json.result as T
}

// ── StellarService ────────────────────────────────────────────────────────────

export class StellarService {
  private rpcServer = new rpc.Server(
    STELLAR_CONFIG[STELLAR_CONFIG.network as 'testnet' | 'mainnet'].sorobanRpcUrl
  )

  private async invokeFactoryView(
    method: string,
    args: xdr.ScVal[],
    sourceAddress: string
  ): Promise<unknown> {
    const factoryContractId = STELLAR_CONFIG.factoryContractId

    if (!factoryContractId) {
      throw new Error('Factory contract ID is missing. Configure VITE_FACTORY_CONTRACT_ID.')
    }

    const source = new Account(sourceAddress, '0')
    const contract = new Contract(factoryContractId)
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build()

    const simulation = await this.rpcServer.simulateTransaction(tx)

    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(simulation.error)
    }

    const result = simulation.result?.retval
    if (!result) {
      throw new Error(`No return value from ${method}`)
    }

    return scValToNative(result)
  }

  async getFactoryState(sourceAddress: string): Promise<FactoryState> {
    const state = (await this.invokeFactoryView('get_state', [], sourceAddress)) as Record<
      string,
      unknown
    >

    return {
      token_count: toNumber(state.token_count),
    }
  }

  async getTokenInfoByIndex(index: number, sourceAddress: string): Promise<FactoryTokenInfo> {
    const rawInfo = (await this.invokeFactoryView(
      'get_token_info',
      [nativeToScVal(index, { type: 'u32' })],
      sourceAddress
    )) as Record<string, unknown>

    return {
      index,
      name: toStringValue(rawInfo.name),
      symbol: toStringValue(rawInfo.symbol),
      decimals: toNumber(rawInfo.decimals),
      creator: toStringValue(rawInfo.creator),
      createdAt: toNumber(rawInfo.created_at),
      tokenAddress: toStringValue(rawInfo.token_address ?? rawInfo.address ?? rawInfo.token),
    }
  }

  async getTokensByCreator(sourceAddress: string): Promise<FactoryTokenInfo[]> {
    const state = await this.getFactoryState(sourceAddress)
    if (!state.token_count) {
      return []
    }

    const tokenRequests = Array.from({ length: state.token_count }, (_, idx) =>
      this.getTokenInfoByIndex(idx + 1, sourceAddress).catch(() => null)
    )

    const tokens = (await Promise.all(tokenRequests)).filter(
      (token): token is FactoryTokenInfo =>
        token !== null && token.creator.toLowerCase() === sourceAddress.toLowerCase()
    )

    return tokens.sort((a, b) => b.createdAt - a.createdAt)
  }

  getExplorerContractUrl(contractAddress: string): string {
    return `${getExplorerBaseUrl()}/contract/${contractAddress}`
  }

  async deployToken(params: unknown): Promise<DeploymentResult> {
    console.log('Deploying token:', params)
    return { tokenAddress: '', transactionHash: '', success: true }
  }

  async getTokenInfo(tokenAddress: string): Promise<unknown> {
    console.log('Getting token info for:', tokenAddress)
    return {}
  }

  async getTransaction(hash: string): Promise<unknown> {
    console.log('Getting transaction:', hash)
    return {}
  }

  /**
   * Fetch contract events for the factory contract, newest-first.
   * @param contractId  Soroban contract address (C...)
   * @param limit       Max events per page (default 20)
   * @param cursor      Opaque pagination cursor from a previous call
   */
  async getContractEvents(
    contractId: string,
    limit = 20,
    cursor?: string,
  ): Promise<GetEventsResult> {
    const params: Record<string, unknown> = {
      filters: [
        {
          type: 'contract',
          contractIds: [contractId],
        },
      ],
      pagination: {
        limit,
        ...(cursor ? { cursor } : {}),
      },
    }

    const result = await rpcCall<RpcGetEventsResult>('getEvents', params)

    const parsed = await Promise.all(result.events.map(parseRpcEvent))
    const events = parsed
      .filter((e): e is ContractEvent => e !== null)
      .sort((a, b) => b.ledger - a.ledger) // newest-first

    const lastEvent = result.events[result.events.length - 1]
    const nextCursor = lastEvent?.pagingToken ?? null

    return { events, cursor: nextCursor }
  }
}

export const stellarService = new StellarService()
