import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isRateLimited } from '../_lib/rateLimit'
import { PINATA_API_URL, pinataHeaders } from '../_lib/pinata'
import { verifyToken } from '../_lib/jwt'

interface UnpinBody {
  cid: string
}

/**
 * Pinata CID pattern: a base58btc multihash (Qm…) for CIDv0 or a base32
 * multihash for CIDv1 (b…). We only ever create CIDv1 pins (cidVersion: 1 in
 * the upload proxies), but accept both shapes so a v0 CID from another source
 * can still be cleaned up.
 */
const CID_PATTERN = /^(Qm[A-Za-z0-9]{44}|b[a-z2-7]{58})$/

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Authenticate: require a valid JWT from the challenge → signature flow,
  // mirroring the upload proxies.
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Authorization required. Request a challenge and sign with your wallet.',
    })
    return
  }

  let walletAddress: string
  try {
    const token = authHeader.slice(7) // Remove "Bearer "
    const payload = verifyToken(token)
    walletAddress = payload.address
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Invalid or expired token.',
    })
    return
  }

  // Check rate limits (per wallet address, durable across instances)
  if (await isRateLimited(walletAddress)) {
    res.status(429).json({ error: 'Too many requests. Please try again later.' })
    return
  }

  const body = req.body as UnpinBody | undefined
  if (!body || typeof body.cid !== 'string' || !CID_PATTERN.test(body.cid)) {
    res.status(400).json({ error: 'Request body must include a valid { cid: string }.' })
    return
  }

  let headers: Record<string, string>
  try {
    headers = pinataHeaders()
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server misconfiguration.' })
    return
  }

  try {
    const pinataRes = await fetch(`${PINATA_API_URL}/pinning/unpin/${body.cid}`, {
      method: 'DELETE',
      headers,
    })

    // Pinata returns 200 for a successful unpin and 404 when the CID was
    // already gone — both are acceptable outcomes for "make sure it is not
    // pinned any more".
    if (pinataRes.ok || pinataRes.status === 404) {
      res.status(200).json({ success: true, cid: body.cid })
      return
    }

    if (pinataRes.status === 429) {
      res.status(502).json({ error: 'Pinata rate limit reached. Please try again later.' })
      return
    }

    res.status(502).json({ error: `Pinata unpin failed (HTTP ${pinataRes.status}).` })
  } catch {
    res.status(500).json({ error: 'Unexpected error while unpinning from IPFS.' })
  }
}
