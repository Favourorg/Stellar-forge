import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from './unpin'
import { issueToken } from '../_lib/jwt'

function fakeReqRes(body: unknown, token?: string) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`

  const req = {
    method: 'POST',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    body,
  } as unknown as VercelRequest

  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  const res = { status } as unknown as VercelResponse

  return { req, res, status, json }
}

let walletCounter = 0
function freshToken(): string {
  walletCounter += 1
  return issueToken(`GUNPINTESTWALLET${walletCounter}`)
}

const VALID_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

describe('POST /api/ipfs/unpin', () => {
  beforeEach(() => {
    process.env.PINATA_API_KEY = 'test-key'
    process.env.PINATA_API_SECRET = 'test-secret'
    process.env.JWT_SECRET = 'test-jwt-secret'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      } as Response),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.PINATA_API_KEY
    delete process.env.PINATA_API_SECRET
    delete process.env.JWT_SECRET
  })

  it('unpins a CID via Pinata using server-side credentials', async () => {
    const { req, res, status, json } = fakeReqRes({ cid: VALID_CID }, freshToken())

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({ success: true, cid: VALID_CID })

    const [url, options] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe(`https://api.pinata.cloud/pinning/unpin/${VALID_CID}`)
    expect((options as RequestInit).method).toBe('DELETE')
    const headers = (options as RequestInit).headers as Record<string, string>
    expect(headers.pinata_api_key).toBe('test-key')
    expect(headers.pinata_secret_api_key).toBe('test-secret')
  })

  it('treats a 404 (CID already gone) as success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response)

    const { req, res, status, json } = fakeReqRes({ cid: VALID_CID }, freshToken())

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({ success: true, cid: VALID_CID })
  })

  it('rejects a missing cid', async () => {
    const { req, res, status } = fakeReqRes({}, freshToken())

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(400)
  })

  it('rejects a malformed cid', async () => {
    const { req, res, status } = fakeReqRes({ cid: '../../etc/passwd' }, freshToken())

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(400)
  })

  it('rejects missing authorization', async () => {
    const { req, res, status } = fakeReqRes({ cid: VALID_CID })

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(401)
  })

  it('surfaces Pinata HTTP failures', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response)

    const { req, res, status } = fakeReqRes({ cid: VALID_CID }, freshToken())

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(502)
  })
})
