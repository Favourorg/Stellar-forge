export type ExplorerType = 'account' | 'transaction' | 'contract'
export type Network = 'mainnet' | 'testnet' | 'standalone'

const VALID_TYPES = new Set<ExplorerType>(['account', 'transaction', 'contract'])

const BASE: Record<Network, string> = {
  mainnet: 'https://stellar.expert/explorer/public',
  testnet: 'https://stellar.expert/explorer/testnet',
  // A local `standalone` network has no public explorer; fall back to the
  // testnet explorer as a best-effort so links don't break in dev/E2E.
  standalone: 'https://stellar.expert/explorer/testnet',
}

const PATH_SEGMENT: Record<ExplorerType, string> = {
  account: 'account',
  transaction: 'tx',
  contract: 'contract',
}

/**
 * Returns a Stellar Expert explorer URL for the given type, id, and network.
 * @throws {Error} if id is empty or type is not a valid ExplorerType
 */
export function stellarExplorerUrl(
  type: ExplorerType,
  id: string,
  network: Network = 'mainnet',
): string {
  if (!VALID_TYPES.has(type)) {
    throw new Error(
      `Invalid explorer type: "${String(type)}". Must be account, transaction, or contract.`,
    )
  }
  if (!id.trim()) {
    throw new Error('Explorer URL requires a non-empty id.')
  }
  return `${BASE[network]}/${PATH_SEGMENT[type]}/${id}`
}
