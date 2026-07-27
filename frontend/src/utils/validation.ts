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

// Full magic-byte signatures for the allowed raster formats. SVG is
// deliberately excluded: it can carry scripts and would turn the IPFS gateway
// into an XSS host. The serverless proxy (api/_lib/fileValidation.ts) is the
// enforcement point; this client-side copy exists for fast feedback only.
const IMAGE_SIGNATURES: Array<{ mimeType: string; bytes: number[] }> = [
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
  { mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
]

const SIGNATURE_SNIFF_BYTES = 12

// FileReader rather than Blob.arrayBuffer(): same browser support, and it
// also works under jsdom in tests, which never implemented arrayBuffer().
const readFileHeader = (file: File, length: number): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file.slice(0, length))
  })

/** Detect the real image type from leading file bytes; null if unrecognized. */
export const sniffImageMimeType = (bytes: Uint8Array): string | null => {
  for (const sig of IMAGE_SIGNATURES) {
    if (bytes.length >= sig.bytes.length && sig.bytes.every((b, i) => bytes[i] === b)) {
      return sig.mimeType
    }
  }
  return null
}

export const isValidImageFile = async (file: File): Promise<{ valid: boolean; error?: string }> => {
  // Kept just under Vercel's 4.5MB serverless function request-body ceiling.
  const maxSize = 4 * 1024 * 1024 // 4MB
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif']

  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: 'Only JPEG, PNG, and GIF images are allowed' }
  }

  if (file.size > maxSize) {
    return { valid: false, error: 'Image size must be less than 4MB' }
  }

  // Check the file's actual content, not just the declared type. The server
  // re-checks this (plus dimension limits); rejecting here just fails faster.
  let header: Uint8Array
  try {
    header = await readFileHeader(file, SIGNATURE_SNIFF_BYTES)
  } catch {
    return { valid: false, error: 'Could not read the selected file' }
  }

  const sniffedType = sniffImageMimeType(header)
  if (!sniffedType) {
    return {
      valid: false,
      error: 'File content is not a recognized JPEG, PNG, or GIF image',
    }
  }
  if (sniffedType !== file.type) {
    return {
      valid: false,
      error: `File content (${sniffedType}) does not match its declared type (${file.type})`,
    }
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

/**
 * Maximum recommended batch size for `create_tokens_batch`.
 *
 * Derived from Soroban resource-cost benchmarks in docs/contract-abi.md.
 * At 20 tokens, the transaction uses approximately 75 % of the CPU-instruction
 * budget, leaving a 25 % safety margin below observed exhaustion at batch
 * size 30. Batches larger than this value will likely fail on-chain with a
 * resource-exhaustion error — after the simulation fee has already been spent.
 *
 * Split larger deployments into sequential calls of ≤ MAX_BATCH_SIZE each.
 */
export const MAX_BATCH_SIZE = 20

/**
 * Validate that a batch token deployment does not exceed the safe resource limit.
 *
 * Returns `{ valid: true }` when the batch is within the safe limit, or
 * `{ valid: false, error: string }` with a human-readable message when it is not.
 */
export function validateBatchSize(count: number): { valid: boolean; error?: string } {
  if (count <= 0) {
    return { valid: false, error: 'Batch must contain at least one token.' }
  }
  if (count > MAX_BATCH_SIZE) {
    return {
      valid: false,
      error:
        `Batch size of ${count} exceeds the maximum recommended batch size of ${MAX_BATCH_SIZE}. ` +
        `Please split your tokens into multiple batches of ≤ ${MAX_BATCH_SIZE} to avoid ` +
        `a failed on-chain transaction. Each failed submission still costs the simulation fee.`,
    }
  }
  return { valid: true }
}
