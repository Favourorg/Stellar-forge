import React from 'react'

import { stroopsToXLM, formatXLM } from '../utils/formatting'
import { useXlmPrice } from '../hooks/useXlmPrice'
import { useFactoryState } from '../hooks/useFactoryState'

interface FeeDisplayProps {
  feeType: 'base' | 'metadata'
  className?: string
  /** When false, render only the amount (+USD) without the "Creation Fee:" prefix. */
  showLabel?: boolean
}

const LABELS: Record<FeeDisplayProps['feeType'], string> = {
  base: 'Creation Fee',
  metadata: 'Metadata Fee',
}

export const FeeDisplay: React.FC<FeeDisplayProps> = ({
  feeType,
  className = '',
  showLabel = true,
}: FeeDisplayProps) => {
  // Source fees from useFactoryState (env-resolved network) so the value matches
  // the rest of the app. The module `stellarService` singleton is never synced
  // to the active network, so reading fees from it would always return testnet.
  const { state, error } = useFactoryState()
  const { price: xlmUsdPrice } = useXlmPrice()

  const label = LABELS[feeType]

  if (error) {
    return <span className={`text-sm text-red-500 ${className}`}>{label}: unavailable</span>
  }

  if (!state) {
    // Loading skeleton
    return (
      <span
        className={`inline-block h-4 w-32 animate-pulse rounded bg-gray-200 ${className}`}
        aria-label={`Loading ${label}…`}
        role="status"
      />
    )
  }

  const stroops = feeType === 'base' ? state.baseFee : state.metadataFee
  const xlm = stroopsToXLM(stroops)
  const usdAmount = xlmUsdPrice !== null ? (xlm * xlmUsdPrice).toFixed(2) : null

  return (
    <span className={`text-sm text-gray-700 ${className}`}>
      {showLabel && `${label}: `}
      {/* formatXLM expects stroops, not the converted XLM value */}
      {formatXLM(stroops)}
      {usdAmount !== null && <span className="text-gray-400 ml-1">≈ ${usdAmount} USD</span>}
    </span>
  )
}
