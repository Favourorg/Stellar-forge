// Validation utilities
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(input: string): Uint8Array {
  const upper = input.toUpperCase().replace(/=+$/, '')
  const length = upper.length
  const count = Math.floor((length * 5) / 8)
  const result = new Uint8Array(count)

  let buffer = 0
  let bitsLeft = 0
  let next = 0

  for (let i = 0; i < length; i++) {
    const val = ALPHABET.indexOf(upper[i]!)
    if (val === -1) throw new Error('Invalid base32 character')
    buffer = (buffer << 5) | val
    bitsLeft += 5
    if (bitsLeft >= 8) {
      result[next++] = (buffer >> (bitsLeft - 8)) & 0xff
      bitsLeft -= 8
    }
  }
  return result
}

function crc16(data: Uint8Array): number {
  let crc = 0x0000
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!
    let code = (crc >>> 8) & 0xff
    code ^= byte
    code ^= code >>> 4
    crc = (crc << 8) ^ (code << 12) ^ (code << 5) ^ code
    crc &= 0xffff
  }
  return crc
}

export const isValidStellarAddress = (address: string): boolean => {
  try {
    if (address.length !== 56) return false
    if (address[0] !== 'G') return false
    const decoded = base32Decode(address)
    if (decoded.length !== 35) return false
    const versionByte = decoded[0]
    if (versionByte !== 0x30) return false // 6 << 3 = 48 (0x30) for Ed25519 Public Key

    const payload = decoded.slice(1, 33)
    const checksum = decoded.slice(33, 35)
    const calculatedCrc = crc16(new Uint8Array([versionByte, ...payload]))
    const expectedCrc = checksum[0]! | (checksum[1]! << 8)
    return calculatedCrc === expectedCrc
  } catch {
    return false
  }
}

export const isValidContractAddress = (address: string): boolean => {
  try {
    if (address.length !== 56) return false
    if (address[0] !== 'C') return false
    const decoded = base32Decode(address)
    if (decoded.length !== 35) return false
    const versionByte = decoded[0]
    if (versionByte !== 0x10) return false // 2 << 3 = 16 (0x10) for Contract

    const payload = decoded.slice(1, 33)
    const checksum = decoded.slice(33, 35)
    const calculatedCrc = crc16(new Uint8Array([versionByte, ...payload]))
    const expectedCrc = checksum[0]! | (checksum[1]! << 8)
    return calculatedCrc === expectedCrc
  } catch {
    return false
  }
}

// Single source of truth for token field rules
const TOKEN_NAME_MIN_LENGTH = 1
const TOKEN_NAME_MAX_LENGTH = 32
const TOKEN_NAME_PATTERN = /^[A-Za-z0-9 _-]+$/

const TOKEN_SYMBOL_MIN_LENGTH = 1
const TOKEN_SYMBOL_MAX_LENGTH = 12
const TOKEN_SYMBOL_PATTERN = /^[A-Za-z0-9-]+$/

const TOKEN_DECIMALS_MIN = 0
const TOKEN_DECIMALS_MAX = 18

const isTokenNameLengthValid = (trimmedName: string): boolean =>
  trimmedName.length >= TOKEN_NAME_MIN_LENGTH && trimmedName.length <= TOKEN_NAME_MAX_LENGTH

const isTokenNamePatternValid = (trimmedName: string): boolean =>
  TOKEN_NAME_PATTERN.test(trimmedName)

const isValidTokenNameValue = (trimmedName: string): boolean =>
  isTokenNameLengthValid(trimmedName) && isTokenNamePatternValid(trimmedName)

const isTokenSymbolLengthValid = (trimmedSymbol: string): boolean =>
  trimmedSymbol.length >= TOKEN_SYMBOL_MIN_LENGTH && trimmedSymbol.length <= TOKEN_SYMBOL_MAX_LENGTH

const isTokenSymbolPatternValid = (trimmedSymbol: string): boolean =>
  TOKEN_SYMBOL_PATTERN.test(trimmedSymbol)

const isValidTokenSymbolValue = (trimmedSymbol: string): boolean =>
  isTokenSymbolLengthValid(trimmedSymbol) && isTokenSymbolPatternValid(trimmedSymbol)

const isValidDecimalsValue = (decimals: number): boolean =>
  decimals >= TOKEN_DECIMALS_MIN && decimals <= TOKEN_DECIMALS_MAX

export const validateTokenParams = (params: {
  name?: string
  symbol?: string
  decimals?: number
  initialSupply?: string
}) => {
  const errors: Record<string, string> = {}

  const trimmedName = params.name?.trim() || ''
  const trimmedSymbol = params.symbol?.trim() || ''

  if (!isTokenNameLengthValid(trimmedName)) {
    errors.name = `Token name must be ${TOKEN_NAME_MIN_LENGTH}-${TOKEN_NAME_MAX_LENGTH} characters`
  } else if (!isTokenNamePatternValid(trimmedName)) {
    errors.name = 'Token name can only contain letters, digits, spaces, hyphens, and underscores'
  }

  if (!isTokenSymbolLengthValid(trimmedSymbol)) {
    errors.symbol = `Token symbol must be ${TOKEN_SYMBOL_MIN_LENGTH}-${TOKEN_SYMBOL_MAX_LENGTH} characters`
  } else if (!isTokenSymbolPatternValid(trimmedSymbol)) {
    errors.symbol = 'Token symbol can only contain alphanumeric characters and hyphens'
  }

  if (
    params.decimals === undefined ||
    params.decimals === null ||
    !isValidDecimalsValue(params.decimals)
  ) {
    errors.decimals = `Decimals must be ${TOKEN_DECIMALS_MIN}-${TOKEN_DECIMALS_MAX}`
  }

  if (!params.initialSupply || parseFloat(params.initialSupply) <= 0) {
    errors.initialSupply = 'Initial supply must be greater than 0'
  }

  return { valid: Object.keys(errors).length === 0, errors }
}

// CIDv0: Qm + 44 base58 chars (total 46); CIDv1: bafy... base32
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/
const CID_V1 = /^b[a-z2-7]{58,}$/

export const isValidIPFSUri = (uri: string): boolean => {
  if (!uri.startsWith('ipfs://')) return false
  const cid = uri.slice(7)
  return CID_V0.test(cid) || CID_V1.test(cid)
}

export const isValidImageFile = (file: File): { valid: boolean; error?: string } => {
  const maxSize = 5 * 1024 * 1024 // 5MB
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif']

  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: 'Only JPEG, PNG, and GIF images are allowed' }
  }

  if (file.size > maxSize) {
    return { valid: false, error: 'Image size must be less than 5MB' }
  }

  return { valid: true }
}

export const validateTokenName = (name: string): boolean => isValidTokenNameValue(name.trim())

export const validateTokenSymbol = (symbol: string): boolean =>
  isValidTokenSymbolValue(symbol.trim())

export const sanitizeTokenInput = (input: string): string => {
  return input.trim()
}

export const validateDecimals = (decimals: number): boolean => isValidDecimalsValue(decimals)
