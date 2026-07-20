// IPFS service - uploads are proxied through our own serverless functions
// (api/ipfs/*) so Pinata credentials never reach the browser bundle.

import { IPFS_CONFIG } from '../config/ipfs'
import { isValidIPFSUri } from '../utils/validation'

// Kept just under Vercel's 4.5MB serverless function request-body ceiling.
const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif']

export interface TokenMetadata {
  name: string
  description: string
  image: string
}

/**
 * Metadata JSON is pinned by whoever calls set_metadata for a token, so it's
 * attacker-controlled. image must be a well-formed ipfs://<cid> value, not just
 * any string, otherwise a malicious URL could flow straight into an <img src>.
 */
export function isTokenMetadata(value: unknown): value is TokenMetadata {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    typeof v.image === 'string' &&
    isValidIPFSUri(v.image)
  )
}

export class IPFSUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IPFSUploadError'
  }
}

function validateImage(image: File): void {
  if (!ALLOWED_TYPES.includes(image.type)) {
    throw new IPFSUploadError(`Unsupported file type "${image.type}". Only JPEG, PNG, and GIF are allowed.`)
  }
  if (image.size > MAX_FILE_SIZE) {
    throw new IPFSUploadError(`File size ${(image.size / 1024 / 1024).toFixed(2)}MB exceeds the 4MB limit.`)
  }
}

export class IPFSService {
  /**
   * Upload an image file to Pinata and pin metadata JSON to IPFS.
   * @param image - JPEG/PNG/GIF file, max 5MB
   * @param description - Token description
   * @param tokenName - Token name
   * @param onProgress - Optional progress callback (0–100)
   * @returns Metadata URI in ipfs:// format
   */
  async uploadMetadata(
    image: File,
    description: string,
    tokenName: string,
    onProgress?: (percent: number) => void
  ): Promise<string> {
    validateImage(image)

    // Step 1: Upload image file
    onProgress?.(0)
    const imageCid = await this._uploadFile(image, onProgress)
    onProgress?.(80)

    // Step 2: Build and upload metadata JSON
    const metadata = {
      name: tokenName,
      description,
      image: `ipfs://${imageCid}`,
    }
    const metadataCid = await this._uploadJSON(metadata, `${tokenName}-metadata.json`)
    onProgress?.(100)

    return `ipfs://${metadataCid}`
  }

  /**
   * Fetch and parse metadata JSON from an ipfs:// URI via the Pinata gateway.
   */
  async getMetadata(uri: string): Promise<TokenMetadata> {
    if (!uri.startsWith('ipfs://')) {
      throw new IPFSUploadError(`Invalid IPFS URI: "${uri}". Expected format: ipfs://<CID>`)
    }

    const cid = uri.replace('ipfs://', '')
    const url = `${IPFS_CONFIG.pinataGateway}/${cid}`

    let response: Response
    try {
      response = await fetch(url)
    } catch {
      throw new IPFSUploadError('Network error while fetching metadata from IPFS gateway. Check your connection.')
    }

    if (!response.ok) {
      throw new IPFSUploadError(`Failed to fetch metadata (HTTP ${response.status}). The CID may not be pinned yet.`)
    }

    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new IPFSUploadError('Metadata response is not valid JSON.')
    }

    if (!isTokenMetadata(data)) {
      throw new IPFSUploadError(
        'Metadata is missing required fields or its image is not a well-formed ipfs:// URI.'
      )
    }

    return data
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _uploadFile(file: File, onProgress?: (percent: number) => void): Promise<string> {
    const formData = new FormData()
    formData.append('file', file)

    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest()

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          // Map upload progress to 0–75% of total
          onProgress(Math.round((e.loaded / e.total) * 75))
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status === 429) {
          reject(new IPFSUploadError('Too many upload requests. Please try again later.'))
          return
        }
        if (xhr.status !== 200) {
          reject(new IPFSUploadError(`Image upload failed (HTTP ${xhr.status}). Please try again.`))
          return
        }
        try {
          const data = JSON.parse(xhr.responseText) as { cid: string }
          resolve(data.cid)
        } catch {
          reject(new IPFSUploadError('Unexpected response while uploading image.'))
        }
      })

      xhr.addEventListener('error', () => {
        reject(new IPFSUploadError('Network error during image upload. Check your connection and try again.'))
      })

      xhr.open('POST', `${IPFS_CONFIG.ipfsProxyUrl}/upload-file`)
      xhr.send(formData)
    })
  }

  private async _uploadJSON(json: object, name: string): Promise<string> {
    let response: Response
    try {
      response = await fetch(`${IPFS_CONFIG.ipfsProxyUrl}/upload-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: json, name }),
      })
    } catch {
      throw new IPFSUploadError('Network error during metadata upload. Check your connection and try again.')
    }

    if (response.status === 429) {
      throw new IPFSUploadError('Too many upload requests. Please try again later.')
    }
    if (!response.ok) {
      throw new IPFSUploadError(`Metadata upload failed (HTTP ${response.status}). Please try again.`)
    }

    const data = (await response.json()) as { cid: string }
    return data.cid
  }
}

export const ipfsService = new IPFSService()
