import {
  isConnected,
  getAddress,
  getNetworkDetails,
  signTransaction as freighterSignTransaction,
} from '@stellar/freighter-api'
import { NETWORK_CONFIGS, type Network } from '../config/stellar'

interface HorizonBalance {
  asset_type: string
  balance: string
}

interface HorizonAccountResponse {
  balances: HorizonBalance[]
}

const FREIGHTER_INSTALL_URL = 'https://www.freighter.app/'
const WALLET_ADDRESS_KEY = 'stellar_wallet_address'

export class WalletService {
  private connectedAddress: string | null = null

  private saveAddress(address: string): void {
    try {
      localStorage.setItem(WALLET_ADDRESS_KEY, address)
    } catch {
      // localStorage unavailable — silently ignore
    }
  }

  private clearAddress(): void {
    try {
      localStorage.removeItem(WALLET_ADDRESS_KEY)
    } catch {
      // localStorage unavailable — silently ignore
    }
  }

  getSavedAddress(): string | null {
    try {
      return localStorage.getItem(WALLET_ADDRESS_KEY)
    } catch {
      return null
    }
  }

  async isInstalled(): Promise<boolean> {
    try {
      const result = await isConnected()
      return !!result.isConnected
    } catch {
      return false
    }
  }

  async connect(): Promise<string> {
    if (!(await this.isInstalled())) {
      throw new Error(
        `Freighter wallet is not installed. Please install it from ${FREIGHTER_INSTALL_URL}`,
      )
    }

    try {
      const addressObj = await getAddress()

      if (addressObj.error) {
        throw new Error(addressObj.error)
      }

      if (!addressObj.address) {
        throw new Error(
          `Freighter wallet is not available. Please install or unlock it from ${FREIGHTER_INSTALL_URL}`,
        )
      }

      this.connectedAddress = addressObj.address
      this.saveAddress(addressObj.address)
      return addressObj.address
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error('Failed to connect to Freighter wallet')
    }
  }

  disconnect(): void {
    this.connectedAddress = null
    this.clearAddress()
  }

  async signTransaction(xdr: string, network: Network): Promise<string> {
    if (!(await this.isInstalled())) {
      throw new Error('Freighter wallet is not installed')
    }

    if (!this.connectedAddress) {
      throw new Error('Wallet not connected. Please connect first.')
    }

    const networkPassphrase = NETWORK_CONFIGS[network].networkPassphrase

    // Freighter's active network isn't push-notified to the page — useNetworkMismatch
    // only polls every few seconds, so its cached state can be stale by the time the
    // user hits submit. Re-check fresh, right before dispatching the sign request, so
    // the actual gate that matters (can *this* transaction be signed) never relies on
    // a value that's up to one poll interval old.
    const freshDetails = await getNetworkDetails()
    if (!freshDetails.error && freshDetails.networkPassphrase !== networkPassphrase) {
      throw new Error(`Network mismatch: Please switch Freighter to ${network}`)
    }

    try {
      const signedResult = await freighterSignTransaction(xdr, {
        networkPassphrase,
        address: this.connectedAddress,
      })

      if (signedResult.error) {
        throw new Error(signedResult.error)
      }

      return signedResult.signedTxXdr
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('network')) {
          throw new Error(`Network mismatch: Please switch Freighter to ${network}`)
        }
        throw new Error(`Failed to sign transaction: ${error.message}`)
      }
      throw new Error('Failed to sign transaction')
    }
  }

  async getBalance(address: string, network: Network): Promise<string> {
    try {
      const horizonUrl = NETWORK_CONFIGS[network].horizonUrl

      const response = await fetch(`${horizonUrl}/accounts/${address}`)

      if (!response.ok) {
        if (response.status === 404) {
          return '0'
        }
        throw new Error(`Failed to fetch account: ${response.statusText}`)
      }

      const accountData: HorizonAccountResponse = await response.json()

      const nativeBalance = accountData.balances.find((balance) => balance.asset_type === 'native')

      return nativeBalance ? nativeBalance.balance : '0'
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get balance: ${error.message}`)
      }
      throw new Error('Failed to get balance')
    }
  }

  async checkExistingConnection(): Promise<string | null> {
    if (!(await this.isInstalled())) {
      return null
    }

    const savedAddress = this.getSavedAddress()
    if (!savedAddress) {
      return null
    }

    try {
      const connectedResult = await isConnected()
      if (connectedResult.error || !connectedResult.isConnected) {
        this.clearAddress()
        return null
      }

      const addressObj = await getAddress()
      if (addressObj.error || !addressObj.address) {
        this.clearAddress()
        return null
      }

      if (addressObj.address !== savedAddress) {
        this.clearAddress()
        this.saveAddress(addressObj.address)
      }

      this.connectedAddress = addressObj.address
      this.saveAddress(addressObj.address)
      return addressObj.address
    } catch {
      this.clearAddress()
      return null
    }
  }

  getConnectedAddress(): string | null {
    return this.connectedAddress
  }
}

export const walletService = new WalletService()
