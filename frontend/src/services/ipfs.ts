// IPFS service for metadata upload via Pinata

import { IPFS_CONFIG } from '../config/ipfs'
import { isValidIPFSUri } from '../utils/validation'
import type { IPFSMetadata } from '../types'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif']

// ── Metadata validation constants ────────────────────────────────────────────

const MAX_NAME_LENGTH = 32
const MAX_DESCRIPTION_LENGTH = 500

/**
 * Validate IPFS-sourced token metadata before it enters app state.
 *
 * This is the sole gate between arbitrary IPFS-pinned JSON and values that
 * downstream consumers (rendering, search/filter, CSV export) treat as
 * well-formed TokenMetadata. Without these checks, any component that
 * accesses `.name`, `.description`, or `.image` on the result of
 * `getMetadata` is implicitly trusting data that a token creator controls
 * entirely — token name/symbol validation at creation time only applies to
 * on-chain parameters, not to the free-form JSON pinned to IPFS.
 *
 * Checks performed:
 *   - `name`:    required, non-empty string, ≤ MAX_NAME_LENGTH chars
 *   - `description`: required, non-empty string, ≤ MAX_DESCRIPTION_LENGTH chars
 *   - `image`:   required, string, must be a valid IPFS URI per isValidIPFSUri
 *
 * @throws IPFSUploadError if any field fails validation.
 * @returns The validated IPFSMetadata object.
 */
export function validateTokenMetadata(raw: Record<string, unknown>): IPFSMetadata {
  const name = raw.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new IPFSUploadError('Token metadata "name" is missing or empty.')
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new IPFSUploadError(
      `Token metadata "name" exceeds ${MAX_NAME_LENGTH} characters (got ${name.length}).`
    )
  }

  const description = raw.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new IPFSUploadError('Token metadata "description" is missing or empty.')
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new IPFSUploadError(
      `Token metadata "description" exceeds ${MAX_DESCRIPTION_LENGTH} characters (got ${description.length}).`
    )
  }

  const image = raw.image
  if (typeof image !== 'string' || image.trim().length === 0) {
    throw new IPFSUploadError('Token metadata "image" is missing or empty.')
  }
  if (!isValidIPFSUri(image)) {
    throw new IPFSUploadError(
      `Token metadata "image" is not a valid IPFS URI (got "${image}"). Expected format: ipfs://<CID>`
    )
  }

  return {
    name,
    description,
    image,
  }
}

export class IPFSConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IPFSConfigError'
  }
}

export class IPFSUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IPFSUploadError'
  }
}

function validateConfig(): void {
  if (!IPFS_CONFIG.apiKey || !IPFS_CONFIG.apiSecret) {
    throw new IPFSConfigError(
      'Pinata API credentials are not configured. Please set VITE_IPFS_API_KEY and VITE_IPFS_API_SECRET in your .env file.'
    )
  }
}

function validateImage(image: File): void {
  if (!ALLOWED_TYPES.includes(image.type)) {
    throw new IPFSUploadError(`Unsupported file type "${image.type}". Only JPEG, PNG, and GIF are allowed.`)
  }
  if (image.size > MAX_FILE_SIZE) {
    throw new IPFSUploadError(`File size ${(image.size / 1024 / 1024).toFixed(2)}MB exceeds the 5MB limit.`)
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
    validateConfig()
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
   * Fetch, parse, and validate metadata JSON from an ipfs:// URI.
   *
   * After fetching and parsing the JSON from the Pinata gateway, the result
   * is run through `validateTokenMetadata` to ensure all required fields
   * (`name`, `description`, `image`) are present, non-empty, and within
   * expected bounds before it reaches downstream consumers.
   *
   * @throws IPFSUploadError if fetching, parsing, or validation fails.
   */
  async getMetadata(uri: string): Promise<IPFSMetadata> {
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

    let parsed: Record<string, unknown>
    try {
      parsed = (await response.json()) as Record<string, unknown>
    } catch {
      throw new IPFSUploadError('Metadata response is not valid JSON.')
    }

    // Validate the parsed metadata before it enters app state
    return validateTokenMetadata(parsed)
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _uploadFile(file: File, onProgress?: (percent: number) => void): Promise<string> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('pinataMetadata', JSON.stringify({ name: file.name }))
    formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }))

    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest()

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          // Map upload progress to 0–75% of total
          onProgress(Math.round((e.loaded / e.total) * 75))
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status === 401) {
          reject(new IPFSUploadError('Pinata authentication failed. Check your API key and secret.'))
          return
        }
        if (xhr.status !== 200) {
          reject(new IPFSUploadError(`Image upload failed (HTTP ${xhr.status}). Please try again.`))
          return
        }
        try {
          const data = JSON.parse(xhr.responseText) as { IpfsHash: string }
          resolve(data.IpfsHash)
        } catch {
          reject(new IPFSUploadError('Unexpected response from Pinata while uploading image.'))
        }
      })

      xhr.addEventListener('error', () => {
        reject(new IPFSUploadError('Network error during image upload. Check your connection and try again.'))
      })

      xhr.open('POST', `${IPFS_CONFIG.pinataApiUrl}/pinning/pinFileToIPFS`)
      xhr.setRequestHeader('pinata_api_key', IPFS_CONFIG.apiKey)
      xhr.setRequestHeader('pinata_secret_api_key', IPFS_CONFIG.apiSecret)
      xhr.send(formData)
    })
  }

  private async _uploadJSON(json: object, name: string): Promise<string> {
    const body = {
      pinataContent: json,
      pinataMetadata: { name },
      pinataOptions: { cidVersion: 1 },
    }

    let response: Response
    try {
      response = await fetch(`${IPFS_CONFIG.pinataApiUrl}/pinning/pinJSONToIPFS`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          pinata_api_key: IPFS_CONFIG.apiKey,
          pinata_secret_api_key: IPFS_CONFIG.apiSecret,
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new IPFSUploadError('Network error during metadata upload. Check your connection and try again.')
    }

    if (response.status === 401) {
      throw new IPFSUploadError('Pinata authentication failed. Check your API key and secret.')
    }
    if (!response.ok) {
      throw new IPFSUploadError(`Metadata upload failed (HTTP ${response.status}). Please try again.`)
    }

    const data = (await response.json()) as { IpfsHash: string }
    return data.IpfsHash
  }
}

export const ipfsService = new IPFSService()
