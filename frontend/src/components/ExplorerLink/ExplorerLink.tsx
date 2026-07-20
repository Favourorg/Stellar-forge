import React from 'react'
import { stellarExplorerUrl } from '../../utils/stellarExplorer'
import { truncateAddress } from '../../utils/truncateAddress'
import type { ExplorerType, Network } from '../../utils/stellarExplorer'

export interface ExplorerLinkProps {
  type: ExplorerType
  id: string
  network: Network
  label?: string
  truncate?: boolean
  className?: string
  showIcon?: boolean
}

const ExternalLinkIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    className="inline-block ml-1 h-3 w-3 flex-shrink-0"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
    />
  </svg>
)

export const ExplorerLink: React.FC<ExplorerLinkProps> = ({
  type,
  id,
  network,
  label,
  truncate = true,
  className = '',
  showIcon = true,
}) => {
  // Render nothing for empty ids — never produce a broken URL
  if (!id.trim()) return null

  const href = stellarExplorerUrl(type, id, network)
  const displayText = label ?? (truncate ? truncateAddress(id) : id)

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={id} className={className}>
      {displayText}
      {showIcon && <ExternalLinkIcon />}
    </a>
  )
}
