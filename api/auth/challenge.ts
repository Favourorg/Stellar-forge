import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomBytes } from 'crypto'
import { issueToken, verifyToken } from '../_lib/jwt'

// Challenges expire after 5 minutes
const CHALLENGE_TTL_MS = 5 * 60 * 1000

interface StoredChallenge {
  value: string
  createdAt: number
}

// In production, swap for Vercel KV. For now, per-instance memory.
// This is acceptable for challenges since they're short-lived and being
// re-requested is not costly — the user can just generate a new one.
const challenges = new Map<string, StoredChallenge>()

// Periodic cleanup: remove expired challenges every minute
setInterval(() => {
  const now = Date.now()
  for (const [address, challenge] of challenges.entries()) {
    if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
      challenges.delete(address)
    }
  }
}, 60 * 1000)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // POST /api/auth/challenge { address: string, signature: string, publicKey: string }
  // Returns: { token: string } if valid, or { error: string }
  //
  // Flow:
  // 1. Frontend calls GET to get a challenge hex string
  // 2. Frontend signs it with Freighter's signMessage
  // 3. Frontend POSTs the signature + address
  // 4. We verify signature and return JWT

  if (req.method === 'GET') {
    return handleGetChallenge(req, res)
  } else if (req.method === 'POST') {
    return handleVerifyChallenge(req, res)
  } else {
    res.status(405).json({ error: 'Method not allowed' })
  }
}

async function handleGetChallenge(req: VercelRequest, res: VercelResponse) {
  const { address } = req.query

  if (typeof address !== 'string' || !address.startsWith('G')) {
    res.status(400).json({ error: 'Missing or invalid address query parameter.' })
    return
  }

  // Generate a new challenge for this address
  const challengeValue = randomBytes(32).toString('hex')
  challenges.set(address, {
    value: challengeValue,
    createdAt: Date.now(),
  })

  res.status(200).json({ challenge: challengeValue })
}

async function handleVerifyChallenge(req: VercelRequest, res: VercelResponse) {
  const { address, signature } = req.body

  if (typeof address !== 'string' || !address.startsWith('G')) {
    res.status(400).json({ error: 'Missing or invalid address.' })
    return
  }

  if (typeof signature !== 'string' || !signature) {
    res.status(400).json({ error: 'Missing signature.' })
    return
  }

  const storedChallenge = challenges.get(address)
  if (!storedChallenge) {
    res.status(400).json({ error: 'Challenge not found or expired. Request a new challenge.' })
    return
  }

  // Verify the signature using Stellar's public key cryptography
  // Freighter's signMessage returns the signature as XDR; we use the Stellar SDK to verify
  try {
    const verified = await verifyStellarSignature(address, storedChallenge.value, signature)

    if (!verified) {
      res.status(401).json({ error: 'Signature verification failed.' })
      challenges.delete(address)
      return
    }

    // Clean up used challenge
    challenges.delete(address)

    // Issue a JWT valid for 5 minutes
    const token = issueToken(address, 5 * 60 * 1000)
    res.status(200).json({ token })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Signature verification failed.',
    })
  }
}

/**
 * Verifies a Stellar message signature.
 * `signature` is the XDR-encoded signed message from Freighter's signMessage.
 * We use ed25519 public key cryptography (Stellar uses ed25519).
 */
async function verifyStellarSignature(
  address: string,
  message: string,
  signatureXdr: string,
): Promise<boolean> {
  try {
    // Import Stellar SDK for verification
    const { StrKey, Keypair, TransactionBuilder } = await import('@stellar/js-sdk')

    // Extract public key from the address (Stellar address is an encoded public key)
    const publicKey = StrKey.decodeEd25519PublicKey(address)

    // Create a keypair from the public key (for verification only)
    const keypair = Keypair.fromPublicKey(address)

    // The signatureXdr from Freighter contains the signature; extract it
    // For simplicity, we assume the signature is base64-encoded directly
    // (Freighter returns the signature directly, not wrapped in XDR)
    const signatureBuffer = Buffer.from(signatureXdr, 'base64')

    // Verify using libsodium/tweetnacl (ed25519)
    const { sign } = await import('tweetnacl')
    const messageBuffer = Buffer.from(message, 'utf-8')

    // ed25519 verification: open returns the message if valid, null if invalid
    const result = sign.detached.verify(messageBuffer, signatureBuffer, publicKey)
    return result
  } catch (err) {
    // If verification fails for any reason, reject
    console.error('Signature verification error:', err)
    return false
  }
}
