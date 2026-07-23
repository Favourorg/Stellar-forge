import type { VercelRequest, VercelResponse } from '@vercel/node'
import Busboy from 'busboy'
import { isRateLimited, clientIp } from '../_lib/rateLimit'
import { PINATA_API_URL, pinataHeaders } from '../_lib/pinata'

// Kept just under Vercel's 4.5MB serverless function request-body ceiling.
const MAX_FILE_SIZE = 4 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif'])

interface ParsedFile {
  buffer: Buffer
  filename: string
  mimeType: string
}

function parseMultipart(req: VercelRequest): Promise<ParsedFile> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers as Record<string, string>,
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    })

    let found: ParsedFile | null = null
    let fileTooLarge = false

    bb.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('limit', () => {
        fileTooLarge = true
      })
      stream.on('end', () => {
        if (!fileTooLarge) {
          found = { buffer: Buffer.concat(chunks), filename: info.filename, mimeType: info.mimeType }
        }
      })
    })

    bb.on('error', reject)
    bb.on('close', () => {
      if (fileTooLarge) {
        reject(new Error('FILE_TOO_LARGE'))
        return
      }
      if (!found) {
        reject(new Error('NO_FILE'))
        return
      }
      resolve(found)
    })

    req.pipe(bb)
  })
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

  let file: ParsedFile
  try {
    file = await parseMultipart(req)
  } catch (err) {
    if (err instanceof Error && err.message === 'FILE_TOO_LARGE') {
      res.status(413).json({ error: 'File exceeds the 4MB limit.' })
      return
    }
    res.status(400).json({ error: 'No valid file uploaded.' })
    return
  }

  if (!ALLOWED_TYPES.has(file.mimeType)) {
    res.status(400).json({ error: `Unsupported file type "${file.mimeType}". Only JPEG, PNG, and GIF are allowed.` })
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
    const formData = new FormData()
    formData.append('file', new Blob([file.buffer], { type: file.mimeType }), file.filename)
    formData.append('pinataMetadata', JSON.stringify({ name: file.filename }))
    formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }))

    const pinataRes = await fetch(`${PINATA_API_URL}/pinning/pinFileToIPFS`, {
      method: 'POST',
      headers,
      body: formData,
    })

    if (!pinataRes.ok) {
      res.status(502).json({ error: `Pinata upload failed (HTTP ${pinataRes.status}).` })
      return
    }

    const data = (await pinataRes.json()) as { IpfsHash: string }
    res.status(200).json({ cid: data.IpfsHash })
  } catch {
    res.status(500).json({ error: 'Unexpected error while uploading to IPFS.' })
  }
}
