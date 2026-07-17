import React, { useEffect, useState } from 'react'
import { Skeleton } from './UI/Skeleton'
import { ipfsService } from '../services/ipfs'
import { ipfsToGatewayUrl } from '../utils/formatting'

interface TokenMetadataResponse {
  image?: string
  name?: string
  description?: string
}

interface TokenMetadataProps {
  metadataUri?: string
  name: string
  symbol: string
  className?: string
}

type FetchState =
  | { status: 'idle' }
  | { status: 'resolved'; uri: string; imageUrl: string; description: string | undefined }
  | { status: 'error'; uri: string }

type ViewState = FetchState | { status: 'loading' }

const PLACEHOLDER_SRC =
  'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 width%3D%22100%22 height%3D%22100%22 viewBox%3D%220 0 100 100%22%3E%3Crect width%3D%22100%22 height%3D%22100%22 fill%3D%22%23e5e7eb%22%2F%3E%3Ctext x%3D%2250%22 y%3D%2255%22 font-size%3D%2232%22 text-anchor%3D%22middle%22 fill%3D%22%239ca3af%22%3E%3F%3C%2Ftext%3E%3C%2Fsvg%3E'

export const TokenMetadata: React.FC<TokenMetadataProps> = ({
  metadataUri,
  name,
  symbol,
  className = '',
}) => {
  const [state, setState] = useState<FetchState>({ status: 'idle' })
  const normalizedMetadataUri = metadataUri?.trim() ?? ''

  useEffect(() => {
    if (!normalizedMetadataUri) {
      return
    }

    let cancelled = false

    ipfsService
      .getMetadata(normalizedMetadataUri)
      .then((data: TokenMetadataResponse) => {
        if (cancelled) return
        if (!data?.image) {
          setState({ status: 'error', uri: normalizedMetadataUri })
          return
        }
        setState({
          status: 'resolved',
          uri: normalizedMetadataUri,
          imageUrl: ipfsToGatewayUrl(data.image),
          description: data.description,
        })
      })
      .catch(() => {
        if (cancelled) return
        setState({ status: 'error', uri: normalizedMetadataUri })
      })

    return () => {
      cancelled = true
    }
  }, [normalizedMetadataUri])

  const viewState: ViewState =
    normalizedMetadataUri && state.status !== 'idle' && state.uri === normalizedMetadataUri
      ? state
      : normalizedMetadataUri
        ? { status: 'loading' }
        : { status: 'idle' }
  const showPlaceholder = viewState.status === 'idle' || viewState.status === 'error'

  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      {viewState.status === 'loading' && (
        <div aria-label="Loading token metadata" aria-busy="true">
          <Skeleton className="h-24 w-24 rounded-full" />
        </div>
      )}

      {viewState.status === 'resolved' && (
        <img
          src={viewState.imageUrl}
          alt={name}
          loading="lazy"
          onError={() => setState({ status: 'error', uri: viewState.uri })}
          className="h-24 w-24 rounded-full object-cover"
        />
      )}

      {showPlaceholder && (
        <img
          data-testid="placeholder-image"
          src={PLACEHOLDER_SRC}
          alt={`${name} placeholder`}
          loading="lazy"
          className="h-24 w-24 rounded-full object-cover"
        />
      )}

      <div className="text-center">
        <p className="font-semibold text-gray-900">{name}</p>
        <p className="text-sm text-gray-500">{symbol}</p>
        {viewState.status === 'resolved' && viewState.description && (
          <p className="mt-1 text-sm text-gray-600">{viewState.description}</p>
        )}
      </div>
    </div>
  )
}
