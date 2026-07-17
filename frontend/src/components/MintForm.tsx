import React, { useEffect, useCallback, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { Input, Button, ConfirmModal, InsufficientBalanceWarning, Select } from './UI'
import { useTransaction } from '../hooks/useTransaction'
import { useTos } from '../context/TosContext'
import { useStellarContext } from '../context/StellarContext'
import { useWalletContext } from '../context/WalletContext'
import { useToast } from '../context/ToastContext'
import { useNetwork } from '../context/NetworkContext'
import { useBalanceCheck } from '../hooks/useBalanceCheck'
import { useTokenDashboard } from '../hooks/useTokenDashboard'
import { isValidStellarAddress, isValidContractAddress } from '../utils/validation'
import { stellarExplorerUrl, stroopsToXLM, formatXLM } from '../utils/formatting'
import { useDebounce } from '../hooks/useDebounce'
import { useFactoryState } from '../hooks/useFactoryState'
import { useNetworkGuard } from '../hooks/useNetworkGuard'
import { FeeDisplay } from './FeeDisplay'
import { useState } from 'react'

// Fallback fee used only until the on-chain factory state loads.
const BASE_FEE_STROOPS = '100000'
const MANUAL_VALUE = '__manual__'

interface MintFormData {
  tokenSelect: string // dropdown value — either a contract address or MANUAL_VALUE
  tokenManual: string // shown only when tokenSelect === MANUAL_VALUE
  recipient: string
  amount: string
}

interface MintFormProps {
  tokenAddress?: string
  onSuccess?: () => void
}

export const MintForm: React.FC<MintFormProps> = ({
  tokenAddress: initialAddress = '',
  onSuccess,
}) => {
  const { stellarService } = useStellarContext()
  const { wallet } = useWalletContext()
  const { network } = useNetwork()
  const { addToast } = useToast()
  const { requireTos } = useTos()
  const { state: factoryState } = useFactoryState()
  const { blocked: networkBlocked, reason: networkReason } = useNetworkGuard()
  // Pay the real on-chain base_fee; the contract rejects mint if fee_payment < base_fee.
  const feePaymentStroops = factoryState?.baseFee ?? BASE_FEE_STROOPS
  const feeXlm = stroopsToXLM(feePaymentStroops)
  const { hasSufficientBalance, shortfall, isTestnet } = useBalanceCheck(feeXlm)
  const { rows: myTokens } = useTokenDashboard()

  const [pending, setPending] = useState(false)
  const [recipientHasAccount, setRecipientHasAccount] = useState<boolean | null>(null)
  const [isCheckingRecipient, setIsCheckingRecipient] = useState(false)
  const [txHash, setTxHash] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<MintFormData>({
    defaultValues: {
      tokenSelect: initialAddress || (myTokens.length > 0 ? myTokens[0]!.address : MANUAL_VALUE),
      tokenManual: initialAddress,
      recipient: '',
      amount: '',
    },
  })

  // React Hook Form's watch() is not memoizable, so the React Compiler skips
  // optimizing this component. That's expected and safe here — we read live
  // form values rather than relying on referential stability.
  // eslint-disable-next-line react-hooks/incompatible-library
  const tokenSelect = watch('tokenSelect')
  const tokenManual = watch('tokenManual')
  const recipient = watch('recipient')
  const amount = watch('amount')

  // Resolved token address: dropdown selection or manual input
  const resolvedTokenAddress = tokenSelect === MANUAL_VALUE ? tokenManual : tokenSelect

  // Token info from dropdown selection
  const selectedToken = myTokens.find((t) => t.address === tokenSelect)

  // Debounced recipient for account-existence check
  const debouncedRecipient = useDebounce(recipient, 500)

  useEffect(() => {
    const trimmed = debouncedRecipient.trim()
    if (!trimmed || !isValidStellarAddress(trimmed)) {
      setRecipientHasAccount(null)
      setIsCheckingRecipient(false)
      return
    }
    let cancelled = false
    setIsCheckingRecipient(true)
    stellarService
      .accountExists(trimmed)
      .then((exists) => {
        if (!cancelled && mountedRef.current) setRecipientHasAccount(exists)
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setRecipientHasAccount(null)
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setIsCheckingRecipient(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedRecipient, stellarService])

  const mintBuilder = useCallback(
    () =>
      stellarService.mintTokens({
        tokenAddress: resolvedTokenAddress,
        to: recipient.trim(),
        amount,
        feePayment: feePaymentStroops,
      }),
    [stellarService, resolvedTokenAddress, recipient, amount, feePaymentStroops],
  )

  const { execute: executeMint, status: txStatus } = useTransaction(mintBuilder)
  const isSubmitting =
    txStatus === 'simulating' ||
    txStatus === 'signing' ||
    txStatus === 'submitting' ||
    txStatus === 'polling'

  const onValid = () => {
    if (!wallet.isConnected) {
      addToast('Connect your wallet first', 'error')
      return
    }
    requireTos(() => setPending(true))
  }

  const handleConfirm = async () => {
    setPending(false)
    try {
      const hash = await executeMint()
      if (mountedRef.current) {
        setTxHash(hash)
        addToast('Tokens minted successfully', 'success')
        onSuccess?.()
      }
    } catch (err) {
      if (mountedRef.current) {
        addToast(err instanceof Error ? err.message : 'Mint failed', 'error')
      }
    }
  }

  const tokenOptions = [
    ...myTokens.map((t) => ({ value: t.address, label: `${t.name} (${t.symbol})` })),
    { value: MANUAL_VALUE, label: 'Manual input…' },
  ]

  return (
    <>
      <form onSubmit={handleSubmit(onValid)} className="space-y-4" noValidate>
        {/* Token selector */}
        <Controller
          name="tokenSelect"
          control={control}
          rules={{ required: 'Select a token' }}
          render={({ field }) => (
            <Select
              label="Token"
              options={
                tokenOptions.length > 1
                  ? tokenOptions
                  : [{ value: MANUAL_VALUE, label: 'Manual input…' }]
              }
              placeholder={myTokens.length === 0 ? 'No tokens found — use manual input' : undefined}
              error={errors.tokenSelect?.message}
              required
              disabled={!!initialAddress}
              {...field}
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
            />
          )}
        />

        {/* Manual token address input */}
        {tokenSelect === MANUAL_VALUE && (
          <Input
            label="Token Address"
            placeholder="C..."
            required
            disabled={!!initialAddress}
            error={errors.tokenManual?.message}
            {...register('tokenManual', {
              required: 'Token address is required',
              validate: (v) =>
                isValidContractAddress(v.trim()) || 'Enter a valid Soroban contract address',
            })}
          />
        )}

        {/* Token info hint */}
        {selectedToken && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Decimals: {selectedToken.decimals} · Creator: {selectedToken.creator.slice(0, 8)}…
          </p>
        )}

        {/* Recipient */}
        <div>
          <Input
            label="Recipient Address"
            placeholder="G..."
            required
            error={errors.recipient?.message}
            {...register('recipient', {
              required: 'Recipient address is required',
              validate: (v) =>
                isValidStellarAddress(v.trim()) || 'Enter a valid Stellar account address',
            })}
            onChange={(e) => {
              register('recipient').onChange(e)
              setRecipientHasAccount(null)
              setIsCheckingRecipient(false)
            }}
          />
          {isCheckingRecipient && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
              Checking whether the recipient account is funded…
            </p>
          )}
          {recipientHasAccount === false && (
            <p
              className="mt-1 text-xs text-amber-600 dark:text-amber-400"
              role="status"
              aria-live="polite"
            >
              This address does not have a Stellar account yet. It may need to be funded first.
            </p>
          )}
        </div>

        {/* Amount */}
        <Input
          label="Amount"
          type="number"
          placeholder="0"
          required
          error={errors.amount?.message}
          {...register('amount', {
            required: 'Amount is required',
            validate: (v) => parseFloat(v) > 0 || 'Amount must be greater than 0',
          })}
        />

        {/* Fee display */}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Estimated fee: <FeeDisplay feeType="base" showLabel={false} className="text-xs" />
        </p>

        <Button
          type="submit"
          variant="primary"
          loading={isSubmitting}
          disabled={isSubmitting || !hasSufficientBalance || networkBlocked}
          className="w-full sm:w-auto"
        >
          {isSubmitting ? 'Processing Transaction…' : 'Mint Tokens'}
        </Button>

        {networkBlocked && networkReason && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {networkReason}
          </p>
        )}

        {!hasSufficientBalance && (
          <InsufficientBalanceWarning shortfall={shortfall} isTestnet={isTestnet} />
        )}
      </form>

      {/* Success feedback with explorer link */}
      {txHash && (
        <div
          role="status"
          className="mt-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 text-sm text-green-800 dark:text-green-300 flex flex-col gap-1"
        >
          <span className="font-medium">✓ Tokens minted successfully</span>
          <a
            href={stellarExplorerUrl('tx', txHash, network)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-green-700 dark:text-green-400 text-xs"
          >
            View on Stellar Explorer →
          </a>
        </div>
      )}

      <ConfirmModal
        isOpen={pending}
        title="Confirm Mint"
        description="You are about to mint tokens to the recipient address. This action cannot be undone."
        details={[
          {
            label: 'Token',
            value: selectedToken
              ? `${selectedToken.name} (${selectedToken.symbol})`
              : resolvedTokenAddress,
          },
          { label: 'Recipient', value: recipient },
          { label: 'Amount', value: amount },
          { label: 'Estimated Fee', value: formatXLM(feePaymentStroops) },
        ]}
        onConfirm={handleConfirm}
        onCancel={() => setPending(false)}
        confirmLabel="Mint Tokens"
      />
    </>
  )
}
