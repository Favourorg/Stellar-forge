import { useState, useEffect } from 'react'
import { Input, Button, ConfirmModal } from './UI'
import { useDebounce } from '../hooks/useDebounce'
import { useTos } from '../context/TosContext'
import { useWalletContext } from '../context/WalletContext'
import { stellarService } from '../services/stellar'
import { isValidStellarAddress } from '../utils/validation'
import type { TokenInfo } from '../types'

const ESTIMATED_FEE = '0.01' // XLM
const ADDRESS_DEBOUNCE_DELAY = 500

interface MintFormProps {
  tokenAddress?: string
  onSuccess?: () => void
}

export const MintForm: React.FC<MintFormProps> = ({
  tokenAddress: initialAddress = '',
  onSuccess,
}) => {
  const [tokenAddress, setTokenAddress] = useState(initialAddress)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null)
  const [pending, setPending] = useState(false)
  const [recipientHasAccount, setRecipientHasAccount] = useState<boolean | null>(null)
  const [recipientValidationError, setRecipientValidationError] = useState<string | null>(null)
  const [isCheckingRecipient, setIsCheckingRecipient] = useState(false)
  const { requireTos } = useTos()
  const { refreshBalance } = useWalletContext()

  const debouncedAddress = useDebounce(tokenAddress, ADDRESS_DEBOUNCE_DELAY)
  const debouncedRecipient = useDebounce(recipient, ADDRESS_DEBOUNCE_DELAY)

  useEffect(() => {
    if (!debouncedAddress) return
    stellarService
      .getTokenInfo(debouncedAddress)
      .then(setTokenInfo)
      .catch(() => setTokenInfo(null))
  }, [debouncedAddress])

  useEffect(() => {
    const trimmedRecipient = debouncedRecipient.trim()

    if (!trimmedRecipient) {
      setRecipientHasAccount(null)
      setRecipientValidationError(null)
      setIsCheckingRecipient(false)
      return
    }

    if (!isValidStellarAddress(trimmedRecipient)) {
      setRecipientHasAccount(null)
      setRecipientValidationError('Enter a valid Stellar account address.')
      setIsCheckingRecipient(false)
      return
    }

    let cancelled = false
    setRecipientValidationError(null)
    setIsCheckingRecipient(true)

    stellarService
      .accountExists(trimmedRecipient)
      .then((exists) => {
        if (cancelled) return
        setRecipientHasAccount(exists)
      })
      .catch(() => {
        if (cancelled) return
        setRecipientHasAccount(null)
        setRecipientValidationError('Could not verify whether this address is funded right now.')
      })
      .finally(() => {
        if (!cancelled) {
          setIsCheckingRecipient(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [debouncedRecipient])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    requireTos(() => setPending(true))
  }

  const handleConfirm = async () => {
    setPending(false)
    // mint logic placeholder
    await refreshBalance()
    onSuccess?.()
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Token Address"
          value={tokenAddress}
          onChange={(e) => setTokenAddress(e.target.value)}
          placeholder="G..."
          required
        />
        {tokenInfo && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Token: {tokenInfo.name} ({tokenInfo.symbol})
          </p>
        )}
        <Input
          label="Recipient Address"
          value={recipient}
          onChange={(e) => {
            setRecipient(e.target.value)
            setRecipientHasAccount(null)
            setRecipientValidationError(null)
            setIsCheckingRecipient(false)
          }}
          placeholder="G..."
          {...(recipientValidationError ? { error: recipientValidationError } : {})}
          required
        />
        {isCheckingRecipient && !recipientValidationError && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Checking whether the recipient account is funded...
          </p>
        )}
        {recipientHasAccount === false && !recipientValidationError && (
          <p className="text-sm text-amber-600 dark:text-amber-400" role="status">
            This address does not have a Stellar account yet. It may need to be funded first.
          </p>
        )}
        <Input
          label="Amount"
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          min="0"
          required
        />
        <Button type="submit" variant="primary" className="w-full sm:w-auto">
          Mint
        </Button>
      </form>

      <ConfirmModal
        isOpen={pending}
        title="Confirm Mint"
        description="You are about to mint tokens to the recipient address."
        details={[
          {
            label: 'Token',
            value: tokenInfo ? `${tokenInfo.name} (${tokenInfo.symbol})` : tokenAddress,
          },
          { label: 'Recipient', value: recipient },
          { label: 'Amount', value: amount },
          { label: 'Estimated Fee', value: `${ESTIMATED_FEE} XLM` },
        ]}
        onConfirm={handleConfirm}
        onCancel={() => setPending(false)}
        confirmLabel="Mint Tokens"
      />
    </>
  )
}
