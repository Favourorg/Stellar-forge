import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isRateLimited } from '../_lib/rateLimit'
import { PINATA_API_URL, pinataHeaders } from '../_lib/pinata'
import { validateTokenMetadata } from '../_lib/schemaValidation'
import { verifyToken } from '../_lib/jwt'

interface UploadJsonBody {
  metadata: unknown
  name: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Authenticate: require a valid JWT from the challenge → signature flow
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
    res.status(429).json({ error: 'Too many upload requests. Please try again later.' })
    return
  }

  const body = req.body as UploadJsonBody | undefined
  if (!body || typeof body.name !== 'string' || typeof body.metadata !== 'object' || body.metadata === null) {
    res.status(400).json({ error: 'Request body must include { metadata: object, name: string }.' })
    return
  }

  // Validate metadata against schema (name, description, image fields)
  // and enforce strict 8 KiB size limit
  const jsonString = JSON.stringify(body.metadata)
  const schemaValidation = validateTokenMetadata(body.metadata, jsonString)
  if (!schemaValidation.valid) {
    res.status(400).json({ error: schemaValidation.error })
    return
  }

  let headers: Record<string, string>
  try {
    headers = pinataHeaders({ 'Content-Type': 'application/json' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server misconfiguration.' })
    return
  }

  try {
    const pinataRes = await fetch(`${PINATA_API_URL}/pinning/pinJSONToIPFS`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        pinataContent: body.metadata,
        pinataMetadata: { name: body.name },
        pinataOptions: { cidVersion: 1 },
      }),
    })

    if (!pinataRes.ok) {
      res.status(502).json({ error: `Pinata upload failed (HTTP ${pinataRes.status}).` })
      return
    }

    const data = (await pinataRes.json()) as { IpfsHash: string }
    res.status(200).json({ cid: data.IpfsHash })
  } catch {
    res.status(500).json({ error: 'Unexpected error while uploading metadata to IPFS.' })
  }
}
