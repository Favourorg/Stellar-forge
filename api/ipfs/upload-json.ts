import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isRateLimited, clientIp } from '../_lib/rateLimit'
import { PINATA_API_URL, pinataHeaders } from '../_lib/pinata'

interface UploadJsonBody {
  metadata: unknown
  name: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (isRateLimited(clientIp(req))) {
    res.status(429).json({ error: 'Too many upload requests. Please try again later.' })
    return
  }

  const body = req.body as UploadJsonBody | undefined
  if (!body || typeof body.name !== 'string' || typeof body.metadata !== 'object' || body.metadata === null) {
    res.status(400).json({ error: 'Request body must include { metadata: object, name: string }.' })
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
