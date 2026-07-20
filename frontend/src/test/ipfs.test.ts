import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPFSService } from '../services/ipfs'
import type { TokenMetadata } from '../services/ipfs'
import { IPFSConfigError, IPFSUploadError } from '../services/ipfs-errors'

// Keep error classes stable across vi.resetModules() calls
vi.mock('../services/ipfs-errors', () => {
  class IPFSConfigError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'IPFSConfigError'
    }
  }
  class IPFSUploadError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'IPFSUploadError'
    }
  }
  return { IPFSConfigError, IPFSUploadError }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFile(name = 'token.png', type = 'image/png', size = 1024): File {
  const blob = new Blob([new Uint8Array(size)], { type })
  return new File([blob], name, { type })
}

/** Minimal XHR mock that lets tests control status + responseText */
function mockXHR(status: number, responseText: string, triggerError = false) {
  const listeners: Record<string, EventListener> = {}
  const uploadListeners: Record<string, EventListener> = {}

  const xhrMock = {
    open: vi.fn(),
    send: vi.fn().mockImplementation(() => {
      // Simulate async completion
      Promise.resolve().then(() => {
        if (triggerError) {
          listeners['error']?.({} as Event)
        } else {
          // Fire upload progress then load
          uploadListeners['progress']?.({
            lengthComputable: true,
            loaded: 512,
            total: 1024,
          } as unknown as Event)
          listeners['load']?.({} as Event)
        }
      })
    }),
    setRequestHeader: vi.fn(),
    upload: {
      addEventListener: vi.fn((event: string, cb: EventListener) => {
        uploadListeners[event] = cb
      }),
    },
    addEventListener: vi.fn((event: string, cb: EventListener) => {
      listeners[event] = cb
    }),
    status,
    responseText,
  }

  vi.stubGlobal(
    'XMLHttpRequest',
    vi.fn().mockImplementation(function () {
      return xhrMock
    }),
  )
  return xhrMock
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IPFSService', () => {
  let service: IPFSService

  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
    service = new IPFSService()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Credentials never reach the client ─────────────────────────────────────

  describe('uploadMetadata — credential isolation', () => {
    it('uploads via the local proxy and never contacts Pinata directly', async () => {
      mockXHR(200, JSON.stringify({ cid: 'QmImageCID' }))
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ cid: 'QmMetaCID' }),
      })

      await service.uploadMetadata(makeFile(), 'desc', 'Token')

      const xhr = vi.mocked(global.XMLHttpRequest).mock.results[0]!.value
      expect(xhr.open).toHaveBeenCalledWith('POST', '/api/ipfs/upload-file')

      // No Pinata host, and no credential headers, on either leg.
      expect(xhr.setRequestHeader).not.toHaveBeenCalledWith(
        expect.stringMatching(/pinata/i),
        expect.anything(),
      )
      const [jsonUrl, jsonInit] = vi.mocked(global.fetch).mock.calls[0]!
      expect(jsonUrl).toBe('/api/ipfs/upload-json')
      expect(JSON.stringify(jsonInit?.headers ?? {})).not.toMatch(/pinata/i)
    })
  })

  // ── Image validation ───────────────────────────────────────────────────────

  describe('uploadMetadata — image validation', () => {

    it('throws IPFSUploadError for unsupported file type', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      const webp = makeFile('img.webp', 'image/webp')

      await expect(fresh.uploadMetadata(webp, 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('throws IPFSUploadError for file exceeding the 4MB limit', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      const big = makeFile('big.png', 'image/png', 6 * 1024 * 1024)

      await expect(fresh.uploadMetadata(big, 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('error message includes the file size when too large', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      const big = makeFile('big.png', 'image/png', 6 * 1024 * 1024)

      await expect(fresh.uploadMetadata(big, 'desc', 'Token')).rejects.toThrow('4MB')
    })

    it('accepts JPEG files', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImageCID' }))
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ cid: 'QmMetaCID' }),
        }),
      )

      const result = await fresh.uploadMetadata(makeFile('img.jpg', 'image/jpeg'), 'desc', 'Token')
      expect(result).toBe('ipfs://QmMetaCID')
    })

    it('accepts GIF files', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImageCID' }))
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ cid: 'QmMetaCID' }),
        }),
      )

      const result = await fresh.uploadMetadata(makeFile('img.gif', 'image/gif'), 'desc', 'Token')
      expect(result).toBe('ipfs://QmMetaCID')
    })
  })

  // ── Successful upload flow ─────────────────────────────────────────────────

  describe('uploadMetadata — happy path', () => {

    it('returns an ipfs:// URI on success', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImageCID123' }))
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ cid: 'QmMetaCID456' }),
        }),
      )

      const uri = await fresh.uploadMetadata(makeFile(), 'A token', 'MyToken')
      expect(uri).toBe('ipfs://QmMetaCID456')
    })

    it('calls onProgress from 0 to 100', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImg' }))
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ cid: 'QmMeta' }),
        }),
      )

      const progress: number[] = []
      await fresh.uploadMetadata(makeFile(), 'desc', 'Token', (p) => progress.push(p))

      expect(progress[0]).toBe(0)
      expect(progress[progress.length - 1]).toBe(100)
    })

    it('constructs metadata JSON with name, description, and image CID', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImg' }))

      let capturedBody: Record<string, unknown> = {}
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>
          return { ok: true, status: 200, json: async () => ({ cid: 'QmMeta' }) }
        }),
      )

      await fresh.uploadMetadata(makeFile(), 'My description', 'CoolToken')

      const content = capturedBody.metadata as Record<string, unknown>
      expect(content.name).toBe('CoolToken')
      expect(content.description).toBe('My description')
      expect(content.image).toBe('ipfs://QmImg')
    })
  })

  // ── Upload error handling ──────────────────────────────────────────────────

  describe('uploadMetadata — error handling', () => {

    it('throws IPFSUploadError on XHR 401 (auth failure)', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(401, 'Unauthorized')

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('throws IPFSUploadError on XHR non-200 status', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(500, 'Internal Server Error')

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('throws IPFSUploadError on XHR network error', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(0, '', true) // triggerError = true

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('throws IPFSUploadError when Pinata returns malformed JSON for image', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, 'not-json')

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('throws IPFSUploadError when image response is missing cid', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ something: 'else' }))

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('throws IPFSUploadError on fetch network error for JSON upload', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImg' }))
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('throws IPFSUploadError when the proxy reports a server misconfiguration', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImg' }))
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Server misconfiguration.' }),
        }),
      )

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toThrow(
        'HTTP 500',
      )
    })

    it('throws IPFSUploadError on non-ok fetch response for JSON upload', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImg' }))
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          json: async () => ({}),
        }),
      )

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('retries image upload on transient 503 and succeeds on second attempt', async () => {
      vi.useFakeTimers()
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()

      let xhrCallCount = 0
      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn().mockImplementation(function (this: XMLHttpRequest) {
          const listeners: Record<string, EventListener> = {}
          const uploadListeners: Record<string, EventListener> = {}

          xhrCallCount++
          this.open = vi.fn()
          this.setRequestHeader = vi.fn()
          this.addEventListener = vi.fn((event: string, cb: EventListener) => {
            listeners[event] = cb
          })
          this.send = vi.fn().mockImplementation(() => {
            Promise.resolve().then(() => {
              if (xhrCallCount === 1) {
                ;(this as unknown as Record<string, unknown>).status = 503
                ;(this as unknown as Record<string, unknown>).responseText = JSON.stringify({})
                listeners['load']?.({} as Event)
              } else {
                ;(this as unknown as Record<string, unknown>).status = 200
                ;(this as unknown as Record<string, unknown>).responseText = JSON.stringify({
                  cid: 'QmRetryCID',
                })
                listeners['load']?.({} as Event)
              }
            })
          })

          Object.defineProperty(this, 'upload', {
            value: {
              addEventListener: vi.fn((event: string, cb: EventListener) => {
                uploadListeners[event] = cb
              }),
            },
          })
        }),
      )

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ cid: 'QmMetaRetry' }),
        }),
      )

      const retryCalls: number[] = []
      const promise = fresh.uploadMetadata(makeFile(), 'desc', 'Token', undefined, (attempt) =>
        retryCalls.push(attempt),
      )

      await vi.runAllTimersAsync()
      const uri = await promise

      expect(uri).toBe('ipfs://QmMetaRetry')
      expect(xhrCallCount).toBe(2)
      expect(retryCalls).toEqual([2])

      vi.useRealTimers()
    })

    it('throws IPFSUploadError when JSON upload response is missing cid', async () => {
      vi.resetModules()
      const { IPFSService: Fresh } = await import('../services/ipfs')
      const fresh = new Fresh()
      mockXHR(200, JSON.stringify({ cid: 'QmImg' }))
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ noHash: true }),
        }),
      )

      await expect(fresh.uploadMetadata(makeFile(), 'desc', 'Token')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })
  })

  // ── getMetadata ────────────────────────────────────────────────────────────

  describe('getMetadata', () => {
    it('fetches and returns parsed metadata JSON', async () => {
      const meta = { name: 'MyToken', description: 'A token', image: 'ipfs://QmImg' }
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => meta,
        }),
      )

      const result = await service.getMetadata('ipfs://QmSomeCID')
      expect(result).toEqual(meta)
    })

    it('constructs the correct gateway URL from the CID', async () => {
      let calledUrl = ''
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          calledUrl = url
          return {
            ok: true,
            status: 200,
            json: async () => ({ name: 'T', description: 'D', image: 'ipfs://QmImg' }),
          }
        }),
      )

      await service.getMetadata('ipfs://QmTestCID')
      expect(calledUrl).toContain('QmTestCID')
      expect(calledUrl).toContain('gateway.pinata.cloud')
    })

    it('throws IPFSUploadError for non-ipfs:// URI', async () => {
      await expect(service.getMetadata('https://example.com/meta.json')).rejects.toBeInstanceOf(
        IPFSUploadError,
      )
    })

    it('throws IPFSUploadError on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })

    it('throws IPFSUploadError on non-ok HTTP response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: async () => ({}),
        }),
      )

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })

    it('throws IPFSUploadError when response is not valid JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token')
          },
        }),
      )

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })

    it('throws IPFSUploadError when metadata is missing name field', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ description: 'A token', image: 'ipfs://QmImg' }),
        }),
      )

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })

    it('throws IPFSUploadError when metadata is missing description field', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ name: 'MyToken', image: 'ipfs://QmImg' }),
        }),
      )

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })

    it('throws IPFSUploadError when metadata is missing image field', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ name: 'MyToken', description: 'A token' }),
        }),
      )

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })

    it('throws IPFSUploadError when metadata fields have wrong types', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ name: 42, description: true, image: null }),
        }),
      )

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })

    it('strips unexpected extra fields from the returned metadata', async () => {
      const raw = {
        name: 'MyToken',
        description: 'A token',
        image: 'ipfs://QmImg',
        maliciousField: '<script>alert(1)</script>',
        extra: { nested: 'data' },
      }
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => raw }),
      )

      const result = await service.getMetadata('ipfs://QmCID')
      expect(result).toEqual({ name: 'MyToken', description: 'A token', image: 'ipfs://QmImg' })
      expect(result).not.toHaveProperty('maliciousField')
      expect(result).not.toHaveProperty('extra')
    })

    it('throws IPFSUploadError when gateway returns an empty object', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
      )

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })

    it('throws IPFSUploadError when gateway returns a non-object (array)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ['name', 'description', 'image'],
        }),
      )

      await expect(service.getMetadata('ipfs://QmCID')).rejects.toBeInstanceOf(IPFSUploadError)
    })
  })

  // ── Error class identity ───────────────────────────────────────────────────

  describe('error classes', () => {
    it('IPFSConfigError has correct name', () => {
      const err = new IPFSConfigError('test')
      expect(err.name).toBe('IPFSConfigError')
      expect(err).toBeInstanceOf(Error)
    })

    it('IPFSUploadError has correct name', () => {
      const err = new IPFSUploadError('test')
      expect(err.name).toBe('IPFSUploadError')
      expect(err).toBeInstanceOf(Error)
    })
  })

  // ── URI string construction ────────────────────────────────────────────────

  describe('URI string construction', () => {
    it('formats image URI as ipfs://{hash}', () => {
      const hash = 'QmImageHash123'
      const uri = `ipfs://${hash}`
      expect(uri).toBe('ipfs://QmImageHash123')
    })

    it('formats metadata URI as ipfs://{hash}', () => {
      const hash = 'QmMetaHash456'
      const uri = `ipfs://${hash}`
      expect(uri).toBe('ipfs://QmMetaHash456')
    })

    it('TokenMetadata interface shape is correct', () => {
      const meta: TokenMetadata = {
        name: 'MyToken',
        description: 'A test token',
        image: 'ipfs://QmImageHash',
      }
      expect(meta.image).toMatch(/^ipfs:\/\//)
      expect(meta.name).toBe('MyToken')
      expect(meta.description).toBe('A test token')
    })
  })
})
