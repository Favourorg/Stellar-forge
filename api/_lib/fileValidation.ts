/**
 * Validates file content against magic bytes (file signatures).
 * Trusts the actual file bytes, not the client-supplied MIME type.
 */

interface FileSignature {
  mimeType: string
  bytes: Buffer
}

const FILE_SIGNATURES: FileSignature[] = [
  { mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { mimeType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  { mimeType: 'image/gif', bytes: Buffer.from([0x47, 0x49, 0x46, 0x38]) }, // GIF87a or GIF89a
]

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif'])

/**
 * Validate file content against magic bytes.
 * @param buffer - File buffer to validate
 * @param clientMimeType - MIME type reported by client (for fallback only)
 * @returns { valid: true, mimeType: string } or { valid: false, error: string }
 */
export function validateFileMagicBytes(
  buffer: Buffer,
  clientMimeType: string,
): { valid: true; mimeType: string } | { valid: false; error: string } {
  // Must have at least 4 bytes for header detection
  if (buffer.length < 4) {
    return { valid: false, error: 'File is too small to determine type.' }
  }

  // Check magic bytes
  for (const sig of FILE_SIGNATURES) {
    if (buffer.subarray(0, sig.bytes.length).equals(sig.bytes)) {
      if (!ALLOWED_MIME_TYPES.has(sig.mimeType)) {
        return { valid: false, error: `File type ${sig.mimeType} is not allowed.` }
      }
      return { valid: true, mimeType: sig.mimeType }
    }
  }

  // No match on magic bytes; reject even if client claims it's valid
  return { valid: false, error: `File format not recognized. Only JPEG, PNG, and GIF are allowed.` }
}
