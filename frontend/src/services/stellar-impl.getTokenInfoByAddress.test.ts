import { describe, test, expect, vi, beforeEach } from 'vitest'
import type { ContractEvent, GetEventsResult } from '../types'

vi.mock('../config/stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/stellar')>()
  return {
    ...actual,
    STELLAR_CONFIG: { ...actual.STELLAR_CONFIG, factoryContractId: 'CFACTORY' },
  }
})

import { StellarService } from './stellar-impl'

/** Matches the default page size in `fetchAllContractEvents`. */
const PAGE_SIZE = 100

const created = (ledger: number, address: string, name: string): ContractEvent => ({
  id: `created-${ledger}`,
  type: 'created',
  ledger,
  timestamp: 1_700_000_000 + ledger,
  txHash: `tx-${ledger}`,
  data: { tokenAddress: address, name, symbol: name.toUpperCase(), creator: `G${name}` },
})

const meta = (ledger: number, address: string, uri: string): ContractEvent => ({
  id: `meta-${ledger}`,
  type: 'meta',
  ledger,
  timestamp: 1_700_000_000 + ledger,
  txHash: `tx-${ledger}`,
  data: { tokenAddress: address, metadataUri: uri },
})

/**
 * Serves `events` in fixed-size pages, mirroring the `getEvents` contract that
 * `fetchAllContractEvents` relies on: ascending ledger order, and a page
 * shorter than the requested limit signals end-of-history.
 */
const pagedSource = (events: ContractEvent[]) => {
  return vi.fn(
    async (_contractId: string, limit = 20, cursor?: string): Promise<GetEventsResult> => {
      const start = cursor ? Number(cursor) : 0
      const slice = events.slice(start, start + limit)
      const next = start + slice.length
      return { events: slice, cursor: next < events.length ? String(next) : null }
    },
  )
}

describe('StellarService.getTokenInfoByAddress', () => {
  let service: StellarService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new StellarService('testnet')
  })

  test('resolves a token whose created event is beyond the first page', async () => {
    // Regression: a single capped getContractEvents(contractId, 100) call
    // returned only the OLDEST 100 events, so this token silently resolved to
    // a placeholder named after its own address instead of its real metadata.
    const events = Array.from({ length: 150 }, (_, i) =>
      created(i + 1, `C_TOKEN_${i}`, `token${i}`),
    )
    const target = events[120]!
    const getContractEvents = pagedSource(events)
    vi.spyOn(service, 'getContractEvents').mockImplementation(getContractEvents)

    const info = await service.getTokenInfoByAddress('C_TOKEN_120')

    expect(info.name).toBe('token120')
    expect(info.symbol).toBe('TOKEN120')
    expect(info.creator).toBe('Gtoken120')
    expect(info.createdAt).toBe(target.timestamp)
    // Proves pagination actually happened rather than one capped call.
    expect(getContractEvents.mock.calls.length).toBeGreaterThan(1)
  })

  test('requests full pages until history is exhausted', async () => {
    const events = Array.from({ length: 250 }, (_, i) =>
      created(i + 1, `C_TOKEN_${i}`, `token${i}`),
    )
    const getContractEvents = pagedSource(events)
    vi.spyOn(service, 'getContractEvents').mockImplementation(getContractEvents)

    await service.getTokenInfoByAddress('C_TOKEN_249')

    // 250 events at 100/page => 3 pages (100, 100, 50-short terminates).
    expect(getContractEvents).toHaveBeenCalledTimes(3)
    expect(getContractEvents.mock.calls[0]?.[1]).toBe(PAGE_SIZE)
  })

  test('throws when no created event exists for the address', async () => {
    vi.spyOn(service, 'getContractEvents').mockImplementation(
      pagedSource([created(1, 'C_OTHER', 'other')]),
    )

    // A rejection is the "not found" signal callers rely on; returning a
    // placeholder here is what made a missing token look like a real one.
    await expect(service.getTokenInfoByAddress('C_MISSING')).rejects.toThrow(
      /No token found at address C_MISSING/,
    )
  })

  test('applies the most recent metadata event for the token', async () => {
    vi.spyOn(service, 'getContractEvents').mockImplementation(
      pagedSource([
        created(1, 'C_TOKEN', 'token'),
        meta(2, 'C_TOKEN', 'ipfs://old'),
        meta(9, 'C_TOKEN', 'ipfs://new'),
        meta(5, 'C_OTHER', 'ipfs://unrelated'),
      ]),
    )

    const info = await service.getTokenInfoByAddress('C_TOKEN')

    expect(info.metadataUri).toBe('ipfs://new')
  })

  test('leaves metadataUri empty when the token has no metadata event', async () => {
    vi.spyOn(service, 'getContractEvents').mockImplementation(
      pagedSource([created(1, 'C_TOKEN', 'token')]),
    )

    const info = await service.getTokenInfoByAddress('C_TOKEN')

    expect(info.metadataUri).toBe('')
  })
})
