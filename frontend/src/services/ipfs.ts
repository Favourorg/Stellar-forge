// IPFS service - uploads are proxied through our own serverless functions
// (api/ipfs/*) so Pinata credentials never reach the browser bundle.

import { IPFS_CONFIG } from '../config/ipfs'
import { withRetry, isTransientError, HttpError } from '../utils/retry'
import { isValidImageFile } from '../utils/validation'
import { IPFSUploadError } from './ipfs-errors'

export { IPFSConfigError, IPFSUploadError } from './ipfs-errors'

export interface TokenMetadata {
  name: string
  description: string
  image: string // ipfs:// URI
}

export interface UploadMetadataOptions {
  image: File
  description: string
  tokenName: string
  onProgress?: (percent: number) => void
  onRetry?: (attempt: number, delayMs: number) => void
}

function isTokenMetadata(value: unknown): value is TokenMetadata {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.image === 'string'
  )
}

// Same-origin serverless proxies. Pinata credentials are read from server env
// inside these handlers, so nothing secret is needed in (or reachable from)
// the browser bundle.
const UPLOAD_FILE_ENDPOINT = '/api/ipfs/upload-file'
const UPLOAD_JSON_ENDPOINT = '/api/ipfs/upload-json'

export class IPFSService {
  /**
   * Upload an image and pin metadata JSON to IPFS via our serverless proxy.
   *
   * Requires no client-side credentials: both hops go to same-origin
   * `api/ipfs/*` handlers that hold the Pinata keys in server env.
   *
   * @param image       - JPEG/PNG/GIF file, max 4MB (Vercel body limit)
   * @param description - Token description
   * @param tokenName   - Token name (used as metadata `name` field)
   * @param onProgress  - Optional progress callback (0–100)
   * @param onRetry     - Optional callback fired before each retry attempt
   * @returns           Metadata URI in ipfs:// format
   *
   * @throws {IPFSUploadError}  On validation failures or exhausted retries
   */
  async uploadMetadata(
    image: File,
    description: string,
    tokenName: string,
    onProgress?: (percent: number) => void,
    onRetry?: (attempt: number, delayMs: number) => void,
  ): Promise<string> {
    const validation = isValidImageFile(image)
    if (!validation.valid) {
      throw new IPFSUploadError(validation.error ?? 'Invalid image file.')
    }

    // Step 1: Upload image file (progress 0 → 75)
    onProgress?.(0)
    const imageCid = await this._uploadFile(image, onProgress, onRetry)

    // Step 2: Build and upload metadata JSON (progress 75 → 100)
    onProgress?.(75)
    const metadata: TokenMetadata = {
      name: tokenName,
      description,
      image: `ipfs://${imageCid}`,
    }
    const metadataCid = await this._uploadJSON(metadata, `${tokenName}-metadata.json`, onRetry)
    onProgress?.(100)

    return `ipfs://${metadataCid}`
  }

  /**
   * Fetch and parse metadata JSON from an ipfs:// URI via the Pinata gateway.
   *
   * @throws {IPFSUploadError} On invalid URI, network errors, or non-JSON responses
   */
  async getMetadata(uri: string): Promise<TokenMetadata> {
    if (!uri.startsWith('ipfs://')) {
      throw new IPFSUploadError(`Invalid IPFS URI: "${uri}". Expected format: ipfs://<CID>`)
    }

    const cid = uri.replace('ipfs://', '')
    const url = `${IPFS_CONFIG.pinataGateway}/${cid}`

    let response: Response
    try {
      response = await withRetry(() => fetch(url), {
        shouldRetry: (err) => isTransientError(err),
      })
    } catch {
      throw new IPFSUploadError(
        'Network error while fetching metadata from IPFS gateway. Check your connection.',
      )
    }

    if (!response.ok) {
      throw new IPFSUploadError(
        `Failed to fetch metadata (HTTP ${response.status}). The CID may not be pinned yet.`,
      )
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      throw new IPFSUploadError('Metadata response is not valid JSON.')
    }

    if (!isTokenMetadata(parsed)) {
      throw new IPFSUploadError(
        'Metadata response is missing required fields (name, description, image).',
      )
    }

    return { name: parsed.name, description: parsed.description, image: parsed.image }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _uploadFile(
    file: File,
    onProgress?: (percent: number) => void,
    onRetry?: (attempt: number, delayMs: number) => void,
  ): Promise<string> {
    const doUpload = (): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && onProgress) {
            onProgress(Math.round((e.loaded / e.total) * 75))
          }
        })

        xhr.addEventListener('load', () => {
          if (xhr.status === 429 || (xhr.status >= 500 && xhr.status < 600)) {
            reject(
              new HttpError(
                xhr.status,
                `Image upload failed (HTTP ${xhr.status})`,
                xhr.status === 429
                  ? parseInt(xhr.getResponseHeader('Retry-After') ?? '0') || undefined
                  : undefined,
              ),
            )
            return
          }

          if (xhr.status !== 200) {
            reject(
              new IPFSUploadError(`Image upload failed (HTTP ${xhr.status}). Please try again.`),
            )
            return
          }
          try {
            const data = JSON.parse(xhr.responseText) as { cid?: string }
            if (!data.cid) {
              reject(new IPFSUploadError('Upload service returned an unexpected response.'))
              return
            }
            resolve(data.cid)
          } catch {
            reject(new IPFSUploadError('Unexpected response from the upload service.'))
          }
        })

        xhr.addEventListener('error', () => {
          reject(new HttpError(0, 'Network error during image upload'))
        })

        xhr.addEventListener('abort', () => {
          reject(new IPFSUploadError('Image upload was aborted.'))
        })

        // Proxied through our own serverless function; Pinata credentials live
        // in server env and must never be sent from the browser.
        xhr.open('POST', UPLOAD_FILE_ENDPOINT)
        xhr.send(formData)
      })

    const formData = new FormData()
    formData.append('file', file)

    return withRetry(doUpload, {
      maxAttempts: 3,
      shouldRetry: (err) => isTransientError(err),
      onRetry,
    }).catch((err) => {
      if (err instanceof IPFSUploadError) throw err
      const httpErr = err instanceof HttpError ? err : null
      if (httpErr) {
        throw new IPFSUploadError(
          httpErr.status === 0
            ? 'Network error during image upload. Check your connection and try again.'
            : `Image upload failed (HTTP ${httpErr.status}). Please try again.`,
        )
      }
      throw err
    })
  }

  private async _uploadJSON(
    json: object,
    name: string,
    onRetry?: (attempt: number, delayMs: number) => void,
  ): Promise<string> {
    // Shape expected by api/ipfs/upload-json; the serverless function wraps it
    // in Pinata's pinataContent/pinataMetadata envelope using server-side creds.
    const body = { metadata: json, name }

    let response: Response
    try {
      response = await withRetry(
        () =>
          fetch(UPLOAD_JSON_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        {
          shouldRetry: (err) => isTransientError(err),
          onRetry,
        },
      )
    } catch {
      throw new IPFSUploadError(
        'Network error during metadata upload. Check your connection and try again.',
      )
    }

    if (response.status === 429) {
      throw new IPFSUploadError('Too many upload requests. Please try again later.')
    }
    if (!response.ok) {
      throw new IPFSUploadError(
        `Metadata upload failed (HTTP ${response.status}). Please try again.`,
      )
    }

    let data: { cid?: string }
    try {
      data = (await response.json()) as { cid?: string }
    } catch {
      throw new IPFSUploadError('The upload service returned a non-JSON response.')
    }

    if (!data.cid) {
      throw new IPFSUploadError('The upload service returned an unexpected response.')
    }

    return data.cid
  }
}

export const ipfsService = new IPFSService()
