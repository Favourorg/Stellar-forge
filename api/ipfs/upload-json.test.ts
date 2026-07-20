import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from './upload-json'

function fakeReqRes(body: unknown, ip = '127.0.0.1') {
  const req = {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
    body,
  } as unknown as VercelRequest

  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  const res = { status } as unknown as VercelResponse

  return { req, res, status, json }
}

describe('POST /api/ipfs/upload-json', () => {
  beforeEach(() => {
    process.env.PINATA_API_KEY = 'test-key'
    process.env.PINATA_API_SECRET = 'test-secret'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ IpfsHash: 'QmMetadataTestCid' }),
      } as Response)
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.PINATA_API_KEY
    delete process.env.PINATA_API_SECRET
  })

  it('pins metadata to Pinata using server-side credentials and returns its cid', async () => {
    const { req, res, status, json } = fakeReqRes(
      { metadata: { name: 'MyToken', description: 'desc', image: 'ipfs://Qm123' }, name: 'MyToken-metadata.json' },
      '198.51.100.1'
    )

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({ cid: 'QmMetadataTestCid' })

    const [, options] = vi.mocked(fetch).mock.calls[0]
    const headers = (options as RequestInit).headers as Record<string, string>
    expect(headers.pinata_api_key).toBe('test-key')
    const sentBody = JSON.parse((options as RequestInit).body as string)
    expect(sentBody.pinataContent).toEqual({ name: 'MyToken', description: 'desc', image: 'ipfs://Qm123' })
  })

  it('rejects a malformed request body before contacting Pinata', async () => {
    const { req, res, status } = fakeReqRes({ name: 'MyToken-metadata.json' }, '198.51.100.2')

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns 500 when server-side Pinata credentials are missing', async () => {
    delete process.env.PINATA_API_SECRET
    const { req, res, status } = fakeReqRes(
      { metadata: { name: 'MyToken', description: 'desc', image: 'ipfs://Qm123' }, name: 'MyToken-metadata.json' },
      '198.51.100.3'
    )

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(500)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects non-POST methods', async () => {
    const { req, res, status } = fakeReqRes({}, '198.51.100.4')
    req.method = 'GET'

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(405)
  })
})
