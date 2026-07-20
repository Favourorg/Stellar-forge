// Validation utilities

export const isValidStellarAddress = (address: string): boolean => {
  // Basic validation for Stellar address
  return address.length === 56 && address.startsWith('G')
}

export const validateTokenParams = (params: {
  name?: string
  symbol?: string
  decimals?: number
  initialSupply?: string
}) => {
  const errors: Record<string, string> = {}

  if (!params.name || params.name.length < 1 || params.name.length > 32) {
    errors.name = 'Token name must be 1-32 characters'
  }

  if (!params.symbol || params.symbol.length < 1 || params.symbol.length > 12) {
    errors.symbol = 'Token symbol must be 1-12 characters'
  }

  if (params.decimals === undefined || params.decimals === null || params.decimals < 0 || params.decimals > 18) {
    errors.decimals = 'Decimals must be 0-18'
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
  // Kept just under Vercel's 4.5MB serverless function request-body ceiling.
  const maxSize = 4 * 1024 * 1024 // 4MB
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif']

  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: 'Only JPEG, PNG, and GIF images are allowed' }
  }

  if (file.size > maxSize) {
    return { valid: false, error: 'Image size must be less than 4MB' }
  }

  return { valid: true }
}

export const validateTokenName = (name: string): boolean => {
  return name.length >= 1 && name.length <= 32
}

export const validateTokenSymbol = (symbol: string): boolean => {
  return symbol.length >= 1 && symbol.length <= 12
}

export const validateDecimals = (decimals: number): boolean => {
  return decimals >= 0 && decimals <= 18
}
