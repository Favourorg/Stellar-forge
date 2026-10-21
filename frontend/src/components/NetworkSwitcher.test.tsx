import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NetworkSwitcher } from './NetworkSwitcher'

const mockSwitchNetwork = vi.fn()
let mockNetwork = 'testnet'
let mockValidationResult: Record<string, { isConfigured: boolean; missingVars: string[] }> = {
  testnet: { isConfigured: true, missingVars: [] },
  mainnet: { isConfigured: true, missingVars: [] },
}

vi.mock('../config/stellar', async () => {
  const actual = await vi.importActual<any>('../config/stellar')
  return {
    ...actual,
    validateNetworkConfig: (n: string) =>
      mockValidationResult[n] ?? { isConfigured: true, missingVars: [] },
  }
})

vi.mock('../context/NetworkContext', () => ({
  useNetwork: () => ({
    network: mockNetwork,
    switchNetwork: mockSwitchNetwork,
    rpcUrl: '',
    horizonUrl: '',
    networkPassphrase: '',
    mismatch: { hasMismatch: false },
  }),
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const map: Record<string, string> = {
        'networkSwitcher.ariaLabel': `Active network: ${opts?.network ?? ''}`,
        'networkSwitcher.selectNetwork': 'Select network',
        'networkSwitcher.testnet': 'Testnet',
        'networkSwitcher.mainnet': 'Mainnet',
        'networkSwitcher.switchToMainnet': 'Switch to Mainnet?',
        'networkSwitcher.switchWarning': 'You are switching to mainnet. Real funds will be used.',
        'networkSwitcher.confirm': 'Switch to Mainnet',
        'networkSwitcher.cancel': 'Cancel',
        'networkSwitcher.unconfiguredTitle': 'Network Not Configured',
        'networkSwitcher.unconfiguredDesc': 'Cannot switch to this network. The following required environment variables are missing:',
        'networkSwitcher.close': 'Close',
      }
      return map[key] ?? key
    },
  }),
}))

describe('NetworkSwitcher', () => {
  beforeEach(() => {
    mockNetwork = 'testnet'
    mockSwitchNetwork.mockReset()
    mockValidationResult = {
      testnet: { isConfigured: true, missingVars: [] },
      mainnet: { isConfigured: true, missingVars: [] },
    }
  })

  const openDropdown = () =>
    fireEvent.click(screen.getByRole('button', { name: /active network/i }))

  // Clicks the <button> inside the list item whose accessible name matches `name`
  const clickOption = (name: RegExp) => {
    const listbox = screen.getByRole('listbox')
    fireEvent.click(within(listbox).getByRole('button', { name }))
  }

  describe('when network is configured', () => {
    it('selecting mainnet opens the confirmation modal', () => {
      render(<NetworkSwitcher />)
      openDropdown()
      clickOption(/mainnet/i)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(mockSwitchNetwork).not.toHaveBeenCalled()
    })

    it('clicking Cancel closes the modal without switching the network', () => {
      render(<NetworkSwitcher />)
      openDropdown()
      clickOption(/mainnet/i)
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(mockSwitchNetwork).not.toHaveBeenCalled()
    })

    it('clicking confirm switches the network and closes the modal', () => {
      render(<NetworkSwitcher />)
      openDropdown()
      clickOption(/mainnet/i)
      fireEvent.click(screen.getByRole('button', { name: /^switch to mainnet$/i }))
      expect(mockSwitchNetwork).toHaveBeenCalledWith('mainnet')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('selecting testnet switches immediately with no modal', () => {
      mockNetwork = 'mainnet'
      render(<NetworkSwitcher />)
      openDropdown()
      clickOption(/^testnet$/i)
      expect(mockSwitchNetwork).toHaveBeenCalledWith('testnet')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('when network is unconfigured (Issue #1016)', () => {
    it('refuses to select an unconfigured network and shows missing variables dialog', () => {
      mockValidationResult.mainnet = {
        isConfigured: false,
        missingVars: ['VITE_FACTORY_CONTRACT_ID_MAINNET', 'VITE_SOROBAN_RPC_URL_MAINNET'],
      }

      render(<NetworkSwitcher />)
      openDropdown()
      clickOption(/mainnet/i)

      // Network must NOT be switched
      expect(mockSwitchNetwork).not.toHaveBeenCalled()

      // Unconfigured warning dialog must appear
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText('Network Not Configured')).toBeInTheDocument()
      expect(screen.getByText('VITE_FACTORY_CONTRACT_ID_MAINNET')).toBeInTheDocument()
      expect(screen.getByText('VITE_SOROBAN_RPC_URL_MAINNET')).toBeInTheDocument()

      // Clicking Close button dismisses the warning
      fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })
})
