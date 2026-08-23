import { describe, it, expect, vi, afterEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isRateLimitDurable } from '../_lib/rateLimit'

vi.mock('../_lib/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/rateLimit')>()
  return {
    ...actual,
    isRateLimitDurable: vi.fn(),
  }
})

const mockIsRateLimitDurable = vi.mocked(isRateLimitDurable)

import handler from './rate-limit'

function fakeReqRes(method = 'GET') {
  const req = { method, headers: {} } as unknown as VercelRequest

  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  const setHeader = vi.fn()
  const res = { status, setHeader } as unknown as VercelResponse

  return { req, res, status, setHeader, json }
}

afterEach(() => {
  vi.restoreAllMocks()
  mockIsRateLimitDurable.mockReset()
})

describe('GET /api/health/rate-limit', () => {
  it('reports durable when KV is configured', () => {
    mockIsRateLimitDurable.mockReturnValue(true)
    const { req, res, status, json } = fakeReqRes()

    handler(req, res)

    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({ durable: true })
  })

  it('reports not durable when KV is not configured', () => {
    mockIsRateLimitDurable.mockReturnValue(false)
    const { req, res, json } = fakeReqRes()

    handler(req, res)

    expect(json).toHaveBeenCalledWith({ durable: false })
  })

  it('rejects non-GET methods', () => {
    const { req, res, status, json } = fakeReqRes('POST')

    handler(req, res)

    expect(status).toHaveBeenCalledWith(405)
    expect(json).toHaveBeenCalledWith({ error: 'Method not allowed' })
  })
})