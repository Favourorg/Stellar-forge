// TypeScript type definitions

export interface TokenDeployParams {
  name: string
  symbol: string
  decimals: number
  initialSupply: string
  salt: string
  tokenWasmHash: string
  feePayment: string
  metadata?: {
    image: File
    description: string
  }
}

export interface DeploymentResult {
  tokenAddress: string
  transactionHash: string
  success: boolean
}

/**
 * TokenInfo matches the contract's TokenInfo struct.
 * All fields are required and correspond directly to contract storage.
 */
export interface TokenInfo {
  name: string
  symbol: string
  decimals: number
  creator: string
  createdAt: number // unix seconds (u64 from contract)
  totalSupply?: string // derived from events, not stored on contract
  metadataUri?: string // stored separately in contract
  /**
   * The token's stable 1-based factory index (`TokenInfo(index)` on-chain).
   * Set when a token is resolved via the index-range path (`getAllTokens`);
   * undefined for tokens resolved purely from events, which carry no index.
   */
  index?: number
}

/**
 * Result of resolving a token by its contract address.
 *
 * Identity (name/symbol/decimals/creator) is resolved from the on-chain
 * `get_token_info_by_address` view — never fabricated from a guessed default
 * or the raw address. When the factory cannot confirm the token, callers get
 * an explicit `unresolved` marker instead of a plausible-looking placeholder,
 * so the UI can render "unresolved" rather than wrong data (e.g. balances off
 * by orders of magnitude from a guessed `decimals`).
 */
export type TokenInfoResult =
  | ({ status: 'resolved' } & TokenInfo)
  | {
      status: 'unresolved'
      address: string
      /** `not-found`: no such token registered with the factory.
       *  `rpc-error`: the factory could not be reached / returned an error. */
      reason: 'not-found' | 'rpc-error'
      message: string
    }

/**
 * Per-token event history plus a disclosure that Soroban RPC only retains
 * events for a bounded window. `retentionLimited` is always true for
 * event-derived history: the RPC cannot serve events older than
 * `retentionDays`, so callers must never present the returned list as the
 * token's complete lifetime.
 */
export interface TokenEventsResult {
  events: ContractEvent[]
  retentionLimited: boolean
  /** Approximate RPC event-retention window, in days. */
  retentionDays: number
  cursor: string | null
}

/**
 * FactoryState matches the contract's FactoryState struct.
 * All fields are required and correspond directly to contract storage.
 */
export interface FactoryState {
  admin: string // Stellar address
  paused: boolean
  treasury: string // Stellar address
  baseFee: string // i128 from contract, represented as string for precision
  metadataFee: string // i128 from contract, represented as string for precision
  tokenCount: number // u32 from contract
  whitelistEnabled: boolean // when true, only whitelisted addresses can create tokens
  /**
   * Lowercase hex encoding of the contract's `token_wasm_hash` (BytesN<32>) —
   * the WASM the factory actually deploys tokens from. Compared against
   * VITE_TOKEN_WASM_HASH to detect frontend/on-chain configuration drift.
   * Optional because older decode paths may not surface it.
   */
  tokenWasmHash?: string | undefined
}

/**
 * ContractError maps contract error enum variants to their numeric codes.
 * Used for error handling and user-facing error messages.
 */
export type ContractError =
  | { code: 1; type: 'InsufficientFee'; message: string }
  | { code: 2; type: 'Unauthorized'; message: string }
  | { code: 3; type: 'InvalidParameters'; message: string }
  | { code: 4; type: 'TokenNotFound'; message: string }
  | { code: 5; type: 'MetadataAlreadySet'; message: string }
  | { code: 6; type: 'AlreadyInitialized'; message: string }
  | { code: 7; type: 'BurnAmountExceedsBalance'; message: string }
  | { code: 8; type: 'BurnNotEnabled'; message: string }
  | { code: 9; type: 'InvalidBurnAmount'; message: string }
  | { code: 10; type: 'ContractPaused'; message: string }

export interface IPFSMetadata {
  name?: string
  description?: string
  image?: string // ipfs:// URI
  [key: string]: unknown
}

export interface AppError {
  code: string
  message: string
}

export type SortOrder = 'newest' | 'oldest' | 'alphabetical'
export type ContractEventType =
  | 'init'
  | 'created'
  | 'meta'
  | 'mint'
  | 'burn'
  | 'fees'
  | 'pause'
  | 'unpause'
  | 'adm_upd'
  | 'wl_add'
  | 'wl_rm'
  | 'wl_tog'

export interface ContractEvent {
  id: string
  type: ContractEventType
  ledger: number
  timestamp: number // unix seconds
  txHash: string
  data: Record<string, string>
}

export interface GetEventsResult {
  events: ContractEvent[]
  cursor: string | null // opaque cursor for pagination
}
