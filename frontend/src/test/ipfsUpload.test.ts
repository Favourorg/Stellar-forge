import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPFSService } from '../services/ipfs'

class FakeXHR {
  static lastUrl = ''
  static lastMethod = ''
  status = 200
  responseText = JSON.stringify({ cid: 'QmFakeImageCid' })
  upload = { addEventListener: () => {} }
  private loadHandler: (() => void) | null = null

  open(method: string, url: string) {
    FakeXHR.lastMethod = method
    FakeXHR.lastUrl = url
  }

  addEventListener(event: string, handler: () => void) {
    if (event === 'load') this.loadHandler = handler
  }

  send() {
    this.loadHandler?.()
  }
}

describe('IPFSService.uploadMetadata', () => {
  const service = new IPFSService()

  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ cid: 'QmFakeMetadataCid' }),
      } as Response),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uploads the image and metadata through the local serverless proxy, never Pinata directly', async () => {
    const file = new File(['fake image bytes'], 'token.png', { type: 'image/png' })

    const uri = await service.uploadMetadata(file, 'A cool token', 'MyToken')

    expect(FakeXHR.lastMethod).toBe('POST')
    expect(FakeXHR.lastUrl).toBe('/api/ipfs/upload-file')
    expect(FakeXHR.lastUrl).not.toMatch(/pinata\.cloud/)

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, options] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('/api/ipfs/upload-json')
    expect(url).not.toMatch(/pinata\.cloud/)

    const sentBody = JSON.parse((options as RequestInit).body as string)
    expect(sentBody.metadata.image).toBe('ipfs://QmFakeImageCid')
    expect(sentBody.name).toBe('MyToken-metadata.json')

    // No Pinata credentials anywhere in the outgoing request.
    expect((options as RequestInit).headers).not.toHaveProperty('pinata_api_key')
    expect((options as RequestInit).headers).not.toHaveProperty('pinata_secret_api_key')

    expect(uri).toBe('ipfs://QmFakeMetadataCid')
  })
})
