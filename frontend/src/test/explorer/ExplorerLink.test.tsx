import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExplorerLink } from '../../components/ExplorerLink/ExplorerLink'

const ID = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345'

describe('ExplorerLink', () => {
  it('renders with target="_blank" and rel="noopener noreferrer"', () => {
    render(<ExplorerLink type="account" id={ID} network="mainnet" />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders nothing when id is empty', () => {
    const { container } = render(<ExplorerLink type="account" id="" network="mainnet" />)
    expect(container.firstChild).toBeNull()
  })

  it('aria-label contains the full untruncated id', () => {
    render(<ExplorerLink type="account" id={ID} network="mainnet" truncate={true} />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('aria-label')).toBe(ID)
  })

  it('generates correct account URL on mainnet', () => {
    render(<ExplorerLink type="account" id={ID} network="mainnet" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://stellar.expert/explorer/public/account/${ID}`,
    )
  })

  it('generates correct transaction URL on testnet', () => {
    render(<ExplorerLink type="transaction" id={ID} network="testnet" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://stellar.expert/explorer/testnet/tx/${ID}`,
    )
  })

  it('generates correct contract URL on testnet', () => {
    render(<ExplorerLink type="contract" id={ID} network="testnet" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `https://stellar.expert/explorer/testnet/contract/${ID}`,
    )
  })

  it('shows truncated display text when truncate=true and no label', () => {
    render(<ExplorerLink type="account" id={ID} network="mainnet" truncate={true} />)
    const link = screen.getByRole('link')
    expect(link.textContent).not.toBe(ID)
    expect(link.textContent).toContain('...')
  })

  it('shows custom label when provided, regardless of truncate', () => {
    render(
      <ExplorerLink type="account" id={ID} network="mainnet" label="My Token" truncate={true} />,
    )
    expect(screen.getByRole('link').textContent).toContain('My Token')
  })
})
