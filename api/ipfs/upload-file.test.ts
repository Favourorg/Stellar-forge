import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from './upload-file'

function buildMultipartBody(fileBuffer: Buffer, filename: string, mimeType: string, boundary: string): Buffer {
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  )
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`)
  return Buffer.concat([preamble, fileBuffer, epilogue])
}

function fakeReqRes(bodyBuffer: Buffer, contentType: string, ip = '127.0.0.1') {
  const req = Readable.from([bodyBuffer]) as unknown as VercelRequest
  req.method = 'POST'
  req.headers = { 'content-type': contentType, 'x-forwarded-for': ip }
  req.socket = { remoteAddress: ip } as never

  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  const res = { status } as unknown as VercelResponse

  return { req, res, status, json }
}

describe('POST /api/ipfs/upload-file', () => {
  const boundary = 'testboundary123'

  beforeEach(() => {
    process.env.PINATA_API_KEY = 'test-key'
    process.env.PINATA_API_SECRET = 'test-secret'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ IpfsHash: 'QmProxyTestCid' }),
      } as Response)
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.PINATA_API_KEY
    delete process.env.PINATA_API_SECRET
  })

  it('forwards a valid image to Pinata using server-side credentials and returns its cid', async () => {
    const body = buildMultipartBody(Buffer.from('fake-png-bytes'), 'token.png', 'image/png', boundary)
    const { req, res, status, json } = fakeReqRes(body, `multipart/form-data; boundary=${boundary}`, '203.0.113.1')

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({ cid: 'QmProxyTestCid' })

    const [, options] = vi.mocked(fetch).mock.calls[0]
    const headers = (options as RequestInit).headers as Record<string, string>
    expect(headers.pinata_api_key).toBe('test-key')
    expect(headers.pinata_secret_api_key).toBe('test-secret')
  })

  it('rejects a disallowed file type before ever contacting Pinata', async () => {
    const body = buildMultipartBody(Buffer.from('binary'), 'payload.exe', 'application/octet-stream', boundary)
    const { req, res, status } = fakeReqRes(body, `multipart/form-data; boundary=${boundary}`, '203.0.113.2')

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns 500 when server-side Pinata credentials are missing', async () => {
    delete process.env.PINATA_API_KEY
    const body = buildMultipartBody(Buffer.from('fake-png-bytes'), 'token.png', 'image/png', boundary)
    const { req, res, status } = fakeReqRes(body, `multipart/form-data; boundary=${boundary}`, '203.0.113.3')

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(500)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects non-POST methods', async () => {
    const { req, res, status } = fakeReqRes(Buffer.from(''), 'application/json', '203.0.113.4')
    req.method = 'GET'

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(405)
  })

  it('returns 429 once the per-IP upload limit is exceeded', async () => {
    const ip = `203.0.113.99-${Math.random()}`
    for (let i = 0; i < 10; i++) {
      const body = buildMultipartBody(Buffer.from('fake-png-bytes'), 'token.png', 'image/png', boundary)
      const { req, res } = fakeReqRes(body, `multipart/form-data; boundary=${boundary}`, ip)
      await handler(req, res)
    }

    const body = buildMultipartBody(Buffer.from('fake-png-bytes'), 'token.png', 'image/png', boundary)
    const { req, res, status } = fakeReqRes(body, `multipart/form-data; boundary=${boundary}`, ip)
    await handler(req, res)

    expect(status).toHaveBeenCalledWith(429)
  })
})
