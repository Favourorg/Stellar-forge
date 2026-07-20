import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TokenMetadata } from './TokenMetadata'
import { ipfsService, type TokenMetadata as TokenMetadataType } from '../services/ipfs'

vi.mock('../services/ipfs', () => ({
  ipfsService: {
    getMetadata: vi.fn(),
  },
}))

const mockedGetMetadata = vi.mocked(ipfsService.getMetadata)

describe('TokenMetadata', () => {
  it('renders an IPFS metadata image through the Pinata gateway', async () => {
    mockedGetMetadata.mockResolvedValueOnce({
      image: 'ipfs://QmTokenImage',
      description: 'Pinned token artwork',
    } as unknown as TokenMetadataType)

    render(<TokenMetadata metadataUri="ipfs://QmMetadata" name="Forge Token" symbol="FORGE" />)

    const image = await screen.findByRole('img', { name: 'Forge Token' })

    expect(mockedGetMetadata).toHaveBeenCalledWith('ipfs://QmMetadata')
    expect(image).toHaveAttribute('src', 'https://gateway.pinata.cloud/ipfs/QmTokenImage')
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(screen.getByText('Pinned token artwork')).toBeInTheDocument()
  })

  it('shows the placeholder when metadata has no image', async () => {
    mockedGetMetadata.mockResolvedValueOnce({
      description: 'No artwork was pinned',
    } as unknown as TokenMetadataType)

    render(<TokenMetadata metadataUri="ipfs://QmMetadata" name="Forge Token" symbol="FORGE" />)

    const placeholder = await screen.findByTestId('placeholder-image')

    expect(placeholder).toHaveAttribute('alt', 'Forge Token placeholder')
    expect(screen.queryByRole('img', { name: 'Forge Token' })).not.toBeInTheDocument()
  })

  it('falls back to the placeholder when the image fails to load', async () => {
    mockedGetMetadata.mockResolvedValueOnce({
      image: 'ipfs://QmBrokenImage',
    } as unknown as TokenMetadataType)

    render(<TokenMetadata metadataUri="ipfs://QmMetadata" name="Forge Token" symbol="FORGE" />)

    fireEvent.error(await screen.findByRole('img', { name: 'Forge Token' }))

    await waitFor(() => {
      expect(screen.getByTestId('placeholder-image')).toHaveAttribute(
        'alt',
        'Forge Token placeholder',
      )
    })
  })
})
