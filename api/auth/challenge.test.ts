import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from './challenge'
import { getChallenge, putChallenge, __resetInMemoryChallenges } from '../_lib/challengeStore'

const ADDRESS = 'GBUKOFF6QUZ4YDTVAJ7NNQZ4LMHFXWNQMPQZ2VDLTMMFVDBLMEXWMXOU'

function fakeReqRes(req: Partial<VercelRequest>) {
  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  const setHeader = vi.fn()
  const res = { status, setHeader } as unknown as VercelResponse
  return { req: { headers: {}, ...req } as unknown as VercelRequest, res, status, json }
}

const get = (address?: string) =>
  fakeReqRes({ method: 'GET', query: address === undefined ? {} : { address } })

const post = (body: unknown) => fakeReqRes({ method: 'POST', body })

beforeEach(() => {
  __resetInMemoryChallenges()
  delete process.env.VERCEL_KV_REST_API_URL
  delete process.env.VERCEL_KV_REST_API_TOKEN
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.VERCEL_KV_REST_API_URL
  delete process.env.VERCEL_KV_REST_API_TOKEN
})

describe('GET /api/auth/challenge', () => {
  it('issues a challenge and persists it in the store', async () => {
    const { req, res, status, json } = get(ADDRESS)

    await handler(req, res)

    expect(status).toHaveBeenCalledWith(200)
    const { challenge } = json.mock.calls[0]![0] as { challenge: string }
    expect(challenge).toMatch(/^[0-9a-f]{64}$/)
    // The value handed to the client is the value a later request will verify.
    expect(await getChallenge(ADDRESS)).toBe(challenge)
  })

  it('issues a fresh challenge on every call', async () => {
    const first = get(ADDRESS)
    await handler(first.req, first.res)
    const second = get(ADDRESS)
    await handler(second.req, second.res)

    const a = (first.json.mock.calls[0]![0] as { challenge: string }).challenge
    const b = (second.json.mock.calls[0]![0] as { challenge: string }).challenge
    expect(a).not.toBe(b)
    expect(await getChallenge(ADDRESS)).toBe(b)
  })

  it('rejects a missing or non-Stellar address with 400', async () => {
    for (const address of [undefined, '', 'CNOTAWALLET']) {
      const { req, res, status } = get(address)
      await handler(req, res)
      expect(status).toHaveBeenCalledWith(400)
    }
  })

  it('returns 500 without handing out a challenge the store never accepted', async () => {
    // Issue #1091: a challenge the client cannot later verify is worse than an
    // error, because it presents as the client's fault.
    process.env.VERCEL_KV_REST_API_URL = 'https://kv.example'
    process.env.VERCEL_KV_REST_API_TOKEN = 'test-token'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { req, res, status, json } = get(ADDRESS)
    await handler(req, res)

    expect(status).toHaveBeenCalledWith(500)
    expect(json.mock.calls[0]![0]).not.toHaveProperty('challenge')
  })
})

describe('POST /api/auth/challenge', () => {
  it('rejects a missing or non-Stellar address with 400', async () => {
    for (const address of [undefined, 42, 'CNOTAWALLET']) {
      const { req, res, status } = post({ address, signature: 'sig' })
      await handler(req, res)
      expect(status).toHaveBeenCalledWith(400)
    }
  })

  it('rejects a missing signature with 400', async () => {
    const { req, res, status, json } = post({ address: ADDRESS })
    await handler(req, res)

    expect(status).toHaveBeenCalledWith(400)
    expect(json).toHaveBeenCalledWith({ error: 'Missing signature.' })
  })

  it('rejects an address with no outstanding challenge with 400', async () => {
    const { req, res, status, json } = post({ address: ADDRESS, signature: 'sig' })
    await handler(req, res)

    expect(status).toHaveBeenCalledWith(400)
    expect(json).toHaveBeenCalledWith({
      error: 'Challenge not found or expired. Request a new challenge.',
    })
  })

  it('rejects a bad signature with 401 and burns the challenge', async () => {
    await putChallenge(ADDRESS, 'deadbeef')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { req, res, status, json } = post({ address: ADDRESS, signature: 'bm90LWEtc2ln' })
    await handler(req, res)

    expect(status).toHaveBeenCalledWith(401)
    expect(json).toHaveBeenCalledWith({ error: 'Signature verification failed.' })
    // One-time use: a rejected attempt must not leave the challenge replayable.
    expect(await getChallenge(ADDRESS)).toBeNull()
  })

  it('reports a store outage as 500, never as an expired challenge', async () => {
    // The distinction matters: 400 tells a correct client to retry forever
    // against a fault it cannot fix.
    process.env.VERCEL_KV_REST_API_URL = 'https://kv.example'
    process.env.VERCEL_KV_REST_API_TOKEN = 'test-token'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { req, res, status } = post({ address: ADDRESS, signature: 'sig' })
    await handler(req, res)

    expect(status).toHaveBeenCalledWith(500)
  })
})

describe('/api/auth/challenge method handling', () => {
  it('rejects anything other than GET or POST with 405', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const { req, res, status } = fakeReqRes({ method })
      await handler(req, res)
      expect(status).toHaveBeenCalledWith(405)
    }
  })
})

// The 200/JWT path is not covered here, and deliberately so: it cannot pass
// today for a reason unrelated to issue #1091. `verifyStellarSignature` does
// `const { sign } = await import('tweetnacl')`, but tweetnacl is CommonJS with
// a default export, so `sign` is `undefined` and the call throws
// `TypeError: Cannot read properties of undefined (reading 'detached')`. The
// catch turns that into `return false`, so *every* signature — including a
// genuinely valid one — is answered with 401. Reading the default export
// (`(await import('tweetnacl')).default.sign`) verifies correctly; tweetnacl
// also needs declaring in package.json, since it is only present today as a
// transitive dependency of stellar-sdk. Tracked separately from #1091.
