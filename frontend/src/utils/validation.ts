// Validation utilities
import { StrKey } from 'stellar-sdk'

export const isValidStellarAddress = (address: string): boolean => {
  return StrKey.isValidEd25519PublicKey(address)
}

export const isValidContractAddress = (address: string): boolean => {
  return StrKey.isValidContract(address)
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
