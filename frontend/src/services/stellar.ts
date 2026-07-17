import type { StellarService as IStellarService } from './stellar-impl'
import type { Network } from '../config/stellar'

export type { FactoryState } from '../types'

export class StellarService {
  private network: Network
  private implPromise: Promise<IStellarService> | null = null

  constructor(network: Network = 'testnet') {
    this.network = network
  }

  setNetwork(network: Network) {
    this.network = network
    this.implPromise = null
  }

  private async getImpl(): Promise<IStellarService> {
    if (!this.implPromise) {
      const { StellarService: Impl } = await import('./stellar-impl')
      this.implPromise = Promise.resolve(new Impl(this.network))
    }
    return this.implPromise
  }

  async deployToken(params: {
    name: string
    symbol: string
    decimals: number
    initialSupply: string
    salt: string
    tokenWasmHash: string
    feePayment: string
  }) {
    const impl = await this.getImpl()
    return impl.deployToken(params)
  }

  async mintTokens(params: {
    tokenAddress: string
    to: string
    amount: string
    feePayment: string
  }) {
    const impl = await this.getImpl()
    return impl.mintTokens(params)
  }

  async burnTokens(params: { tokenAddress: string; amount: string }) {
    const impl = await this.getImpl()
    return impl.burnTokens(params)
  }

  async setMetadata(params: { tokenAddress: string; metadataUri: string; feePayment: string }) {
    const impl = await this.getImpl()
    return impl.setMetadata(params)
  }

  async getTokenInfo(index: number) {
    const impl = await this.getImpl()
    return impl.getTokenInfo(index)
  }

  async getTransaction(hash: string) {
    const impl = await this.getImpl()
    return impl.getTransaction(hash)
  }

  async getFactoryState() {
    const impl = await this.getImpl()
    return impl.getFactoryState()
  }

  async accountExists(address: string) {
    const impl = await this.getImpl()
    return impl.accountExists(address)
  }

  async updateFees(params: { baseFee: string; metadataFee: string }) {
    const impl = await this.getImpl()
    return impl.updateFees(params)
  }

  async getContractEvents(contractId: string, limit?: number, cursor?: string) {
    const impl = await this.getImpl()
    return impl.getContractEvents(contractId, limit, cursor)
  }

  async getAllTokens() {
    const impl = await this.getImpl()
    return impl.getAllTokens()
  }

  async getTokensByCreator(creator: string, offset: number, limit: number) {
    const impl = await this.getImpl()
    return impl.getTokensByCreator(creator, offset, limit)
  }

  async getTokenInfoByAddress(tokenAddress: string) {
    const impl = await this.getImpl()
    return impl.getTokenInfoByAddress(tokenAddress)
  }

  async getTokenEvents(tokenAddress: string, limit?: number, cursor?: string) {
    const impl = await this.getImpl()
    return impl.getTokenEvents(tokenAddress, limit, cursor)
  }
}

export const stellarService = new StellarService()

export async function buildFeeBumpTransaction(
  innerTxXdr: string,
  feeSource: string,
  network: Network,
  baseFee?: string,
): Promise<string> {
  const { buildFeeBumpTransaction: impl } = await import('./stellar-impl')
  return impl(innerTxXdr, feeSource, network, baseFee)
}

export async function submitFeeBumpTransaction(
  signedFeeBumpXdr: string,
  network: Network,
): Promise<string> {
  const { submitFeeBumpTransaction: impl } = await import('./stellar-impl')
  return impl(signedFeeBumpXdr, network)
}
