import { describe, it, expect } from 'vitest'
import { stellarExplorerUrl } from '../../utils/stellarExplorer'

const ID = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345'

describe('stellarExplorerUrl', () => {
  // 6 URL correctness cases
  it('account mainnet', () => {
    expect(stellarExplorerUrl('account', ID, 'mainnet')).toBe(
      `https://stellar.expert/explorer/public/account/${ID}`,
    )
  })
  it('transaction mainnet', () => {
    expect(stellarExplorerUrl('transaction', ID, 'mainnet')).toBe(
      `https://stellar.expert/explorer/public/tx/${ID}`,
    )
  })
  it('contract mainnet', () => {
    expect(stellarExplorerUrl('contract', ID, 'mainnet')).toBe(
      `https://stellar.expert/explorer/public/contract/${ID}`,
    )
  })
  it('account testnet', () => {
    expect(stellarExplorerUrl('account', ID, 'testnet')).toBe(
      `https://stellar.expert/explorer/testnet/account/${ID}`,
    )
  })
  it('transaction testnet', () => {
    expect(stellarExplorerUrl('transaction', ID, 'testnet')).toBe(
      `https://stellar.expert/explorer/testnet/tx/${ID}`,
    )
  })
  it('contract testnet', () => {
    expect(stellarExplorerUrl('contract', ID, 'testnet')).toBe(
      `https://stellar.expert/explorer/testnet/contract/${ID}`,
    )
  })

  it('throws when id is empty', () => {
    expect(() => stellarExplorerUrl('account', '', 'mainnet')).toThrow()
  })

  it('throws when id is whitespace only', () => {
    expect(() => stellarExplorerUrl('account', '   ', 'mainnet')).toThrow()
  })

  it('throws when type is invalid', () => {
    // @ts-expect-error intentional invalid type
    expect(() => stellarExplorerUrl('token', ID, 'mainnet')).toThrow()
  })
})
