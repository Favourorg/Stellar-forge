import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomBytes } from 'crypto'
import { issueToken, verifyToken } from '../_lib/jwt'
import { deleteChallenge, getChallenge, putChallenge } from '../_lib/challengeStore'
import { isRateLimited } from '../_lib/rateLimit'

// Challenge storage — TTL, one-time use and the durable/dev-fallback split all
// live in `../_lib/challengeStore` (issue #1091). It used to be a Map in this
// module, which meant the GET that issued a challenge and the POST that
// verified it had to be served by the same instance to work at all.

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

  // Rate limit per address to prevent abuse (challenge issuance has no
  // proof-of-possession, so it gets a tighter window than upload endpoints)
  if (await isRateLimited(address)) {
    res.status(429).json({ error: 'Too many challenge requests. Please try again later.' })
    return
  }

  // Generate a new challenge for this address
  const challengeValue = randomBytes(32).toString('hex')

  // The challenge is only handed to the client once it is durably stored. A
  // failed write would otherwise produce a challenge that no later request can
  // verify — the exact symptom issue #1091 exists to remove.
  try {
    await putChallenge(address, challengeValue)
  } catch (err) {
    console.error('Failed to store auth challenge:', err)
    res.status(500).json({ error: 'Could not issue a challenge. Try again.' })
    return
  }

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

  // Rate limit per address to prevent brute-force probing of the
  // signature-verification path
  if (await isRateLimited(address)) {
    res.status(429).json({ error: 'Too many verification attempts. Please try again later.' })
    return
  }

  // A store failure must not be reported as a missing challenge: that would
  // tell a correct client to request a new one, forever, while the real fault
  // is server-side.
  let storedChallenge: string | null
  try {
    storedChallenge = await getChallenge(address)
  } catch (err) {
    console.error('Failed to read auth challenge:', err)
    res.status(500).json({ error: 'Could not verify the challenge. Try again.' })
    return
  }

  if (!storedChallenge) {
    res.status(400).json({ error: 'Challenge not found or expired. Request a new challenge.' })
    return
  }

  // Verify the signature using Stellar's public key cryptography
  // Freighter's signMessage returns the signature as XDR; we use the Stellar SDK to verify
  try {
    const verified = await verifyStellarSignature(address, storedChallenge, signature)

    if (!verified) {
      res.status(401).json({ error: 'Signature verification failed.' })
      await deleteChallenge(address)
      return
    }

    // Clean up used challenge
    await deleteChallenge(address)

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
    // The package is `stellar-sdk`; `@stellar/js-sdk` does not exist on npm,
    // so this import used to throw and every verification silently fell
    // through to `return false`.
    const { StrKey, Keypair, TransactionBuilder } = await import('stellar-sdk')

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
