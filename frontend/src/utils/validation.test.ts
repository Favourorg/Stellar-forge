import { describe, it, expect } from 'vitest'
import {
  isValidStellarAddress,
  validateTokenParams,
  isValidImageFile,
} from './validation'

// Real valid Ed25519 public key
const VALID_ADDRESS = 'GDNQ2ULB7MXLA4GJBTAAZQON3IEO4HUCYFQMAHVAA2RTC4L4B4G5IK4C'

describe('isValidStellarAddress', () => {
  it('accepts a valid G-address', () => {
    expect(isValidStellarAddress(VALID_ADDRESS)).toBe(true)
  })

  it('rejects an address that is too short', () => {
    expect(isValidStellarAddress('GABC')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidStellarAddress('')).toBe(false)
  })

  it('rejects a string not starting with G', () => {
    expect(isValidStellarAddress('XABC' + 'A'.repeat(52))).toBe(false)
  })

  it('rejects a malformed string', () => {
    expect(isValidStellarAddress('not-a-stellar-address')).toBe(false)
  })

  it('rejects a contract address (C...) as an account address', () => {
    expect(isValidStellarAddress('CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE')).toBe(false)
  })
})

const BASE = { name: 'MyToken', symbol: 'MTK', decimals: 7, initialSupply: '1000' }

describe('validateTokenParams', () => {
  it('accepts a fully valid object', () => {
    expect(validateTokenParams(BASE).valid).toBe(true)
  })

  it('rejects missing name', () => {
    const { valid, errors } = validateTokenParams({ ...BASE, name: '' })
    expect(valid).toBe(false)
    expect(errors.name).toBeDefined()
  })

  it('rejects name longer than 32 characters', () => {
    const { valid, errors } = validateTokenParams({ ...BASE, name: 'A'.repeat(33) })
    expect(valid).toBe(false)
    expect(errors.name).toBeDefined()
  })

  it('rejects missing symbol', () => {
    const { valid, errors } = validateTokenParams({ ...BASE, symbol: '' })
    expect(valid).toBe(false)
    expect(errors.symbol).toBeDefined()
  })

  it('rejects symbol longer than 12 characters', () => {
    const { valid, errors } = validateTokenParams({ ...BASE, symbol: 'A'.repeat(13) })
    expect(valid).toBe(false)
    expect(errors.symbol).toBeDefined()
  })

  it('accepts decimals = 0 (boundary)', () => {
    expect(validateTokenParams({ ...BASE, decimals: 0 }).valid).toBe(true)
  })

  it('accepts decimals = 18 (boundary)', () => {
    expect(validateTokenParams({ ...BASE, decimals: 18 }).valid).toBe(true)
  })

  it('rejects decimals = -1', () => {
    const { valid, errors } = validateTokenParams({ ...BASE, decimals: -1 })
    expect(valid).toBe(false)
    expect(errors.decimals).toBeDefined()
  })

  it('rejects decimals = 19', () => {
    const { valid, errors } = validateTokenParams({ ...BASE, decimals: 19 })
    expect(valid).toBe(false)
    expect(errors.decimals).toBeDefined()
  })

  it('rejects missing decimals', () => {
    const { valid, errors } = validateTokenParams({ name: BASE.name, symbol: BASE.symbol, initialSupply: BASE.initialSupply })
    expect(valid).toBe(false)
    expect(errors.decimals).toBeDefined()
  })

  it('rejects zero initial supply', () => {
    const { valid, errors } = validateTokenParams({ ...BASE, initialSupply: '0' })
    expect(valid).toBe(false)
    expect(errors.initialSupply).toBeDefined()
  })

  it('rejects missing initial supply', () => {
    const { valid, errors } = validateTokenParams({ ...BASE, initialSupply: '' })
    expect(valid).toBe(false)
    expect(errors.initialSupply).toBeDefined()
  })
})

describe('isValidImageFile', () => {
  const makeFile = (type: string, size: number) => ({ type, size }) as File

  it('accepts a valid PNG under 5MB', () => {
    expect(isValidImageFile(makeFile('image/png', 1024)).valid).toBe(true)
  })

  it('accepts a valid JPEG under 5MB', () => {
    expect(isValidImageFile(makeFile('image/jpeg', 1024)).valid).toBe(true)
  })

  it('accepts a valid GIF under 5MB', () => {
    expect(isValidImageFile(makeFile('image/gif', 1024)).valid).toBe(true)
  })

  it('rejects a PDF file', () => {
    const result = isValidImageFile(makeFile('application/pdf', 1024))
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('rejects an exe file', () => {
    const result = isValidImageFile(makeFile('application/octet-stream', 1024))
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('rejects a file over 5MB', () => {
    const result = isValidImageFile(makeFile('image/png', 6 * 1024 * 1024))
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('rejects a file exactly at the 5MB limit', () => {
    const result = isValidImageFile(makeFile('image/png', 5 * 1024 * 1024 + 1))
    expect(result.valid).toBe(false)
  })
})
