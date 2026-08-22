import { createHmac, randomBytes } from 'crypto'

interface TokenPayload {
  address: string
  iat: number
  exp: number
}

/**
 * Issues a short-lived JWT (5 minutes) for a verified wallet address.
 * Used to authenticate subsequent upload requests without re-signing.
 */
export function issueToken(address: string, expiresIn = 5 * 60 * 1000): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not configured.')
  }

  const now = Math.floor(Date.now() / 1000)
  const payload: TokenPayload = {
    address,
    iat: now,
    exp: now + Math.floor(expiresIn / 1000),
  }

  const header = { alg: 'HS256', typ: 'JWT' }
  const headerEncoded = base64urlEncode(JSON.stringify(header))
  const payloadEncoded = base64urlEncode(JSON.stringify(payload))
  const message = `${headerEncoded}.${payloadEncoded}`

  const signature = createHmac('sha256', secret).update(message).digest('base64url')

  return `${message}.${signature}`
}

/**
 * Verifies a JWT and returns the payload if valid.
 * Rejects if signature is invalid or token is expired.
 */
export function verifyToken(token: string): TokenPayload {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not configured.')
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid token format.')
  }

  const [headerEncoded, payloadEncoded, signatureProvided] = parts
  const message = `${headerEncoded}.${payloadEncoded}`

  // Verify signature
  const expectedSignature = createHmac('sha256', secret).update(message).digest('base64url')
  if (signatureProvided !== expectedSignature) {
    throw new Error('Invalid token signature.')
  }

  // Decode and parse payload
  const payload: TokenPayload = JSON.parse(base64urlDecode(payloadEncoded))

  // Check expiration
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token has expired.')
  }

  return payload
}

/** URL-safe base64 encode (per RFC 4648) */
function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url')
}

/** URL-safe base64 decode */
function base64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf-8')
}
