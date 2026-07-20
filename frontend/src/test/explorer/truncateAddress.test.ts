import { describe, it, expect } from 'vitest'
import { truncateAddress } from '../../utils/truncateAddress'

describe('truncateAddress', () => {
  it('truncates a full Stellar address to GABCDE...WXYZ format', () => {
    const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    const result = truncateAddress(addr)
    expect(result).toBe('GABCDE...2345')
    expect(result).toMatch(/^.{6}\.\.\.(.{4})$/)
  })

  it('does not truncate short strings', () => {
    expect(truncateAddress('GABC')).toBe('GABC')
    expect(truncateAddress('GABCDEFGHIJ', 6, 4)).toBe('GABCDE...GHIJ')
  })

  it('returns string unchanged when exactly at threshold', () => {
    expect(truncateAddress('GABCDEFGHIJ', 6, 5)).toBe('GABCDEFGHIJ')
  })

  it('respects custom startChars and endChars', () => {
    const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    expect(truncateAddress(addr, 4, 4)).toBe('GABC...2345')
  })
})
