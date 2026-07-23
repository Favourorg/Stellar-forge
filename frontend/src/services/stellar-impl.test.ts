/**
 * Unit tests for parseRpcEvent and CONTRACT_TOPIC_MAP.
 *
 * XDR fixtures are real base64-encoded ScVal blobs generated with stellar-sdk
 * (Keypair.random() addresses are embedded in the XDR, so they are stable
 * across runs).  Every test decodes from the raw wire format all the way to
 * the ContractEvent shape, proving the full parse path.
 *
 * These two test addresses are baked into the XDR fixtures below:
 *   ADDR1 = GD73JKOGSEGFO7PJLZFWL6MT7HOF7L27NJX6AJ3QOWIM45AMHNT7T7JE
 *   ADDR2 = GB5QBV5XY4AUAZ4VQENJDW7A4KHHH77CIDAUXVJT476ZAKHTVC36S3MD
 */

import { describe, it, expect } from 'vitest'
import { parseRpcEvent, CONTRACT_TOPIC_MAP } from './stellar-impl'
import type { RpcEventResponse } from './stellar-impl'

// ── Test addresses (embedded in the XDR fixtures) ─────────────────────────────

const ADDR1 = 'GD73JKOGSEGFO7PJLZFWL6MT7HOF7L27NJX6AJ3QOWIM45AMHNT7T7JE'
const ADDR2 = 'GB5QBV5XY4AUAZ4VQENJDW7A4KHHH77CIDAUXVJT476ZAKHTVC36S3MD'

// topic[0] is always symbol_short!("factory"), topic[1] is the action symbol.
const FACTORY_TOPIC = 'AAAADwAAAAdmYWN0b3J5AA=='

// ── XDR fixtures ─────────────────────────────────────────────────────────────
// Generated with stellar-sdk: xdr.ScVal.scvSymbol / scvVec / scvAddress etc.

const XDR = {
  init: {
    topic1: 'AAAADwAAAARpbml0',
    value:
      'AAAAEAAAAAEAAAABAAAAEgAAAAAAAAAA/7SpxpEMV33pXktl+ZP53F+vX2pv4CdwdZDOdAw7Z/k=',
  },
  created: {
    topic1: 'AAAADwAAAAdjcmVhdGVkAA==',
    value:
      'AAAAEAAAAAEAAAAEAAAAEgAAAAAAAAAAewDXt8cBQGeVgRqR2+DijnP/4kDBS9Uz5/2QKPOot+kAAAASAAAAAAAAAAD/tKnGkQxXfeleS2X5k/ncX69fam/gJ3B1kM50DDtn+QAAAA4AAAAHTXlUb2tlbgAAAAAOAAAAA01USwA=',
  },
  meta: {
    topic1: 'AAAADwAAAARtZXRh',
    value:
      'AAAAEAAAAAEAAAACAAAAEgAAAAAAAAAAewDXt8cBQGeVgRqR2+DijnP/4kDBS9Uz5/2QKPOot+kAAAAOAAAANWlwZnM6Ly9RbVhveXBpempXM1drbkZpSm5LTHdIQ25MNzJ2ZWR4alFrRERQMW1YV282dWNvAAAA',
  },
  mint: {
    topic1: 'AAAADwAAAARtaW50',
    value:
      'AAAAEAAAAAEAAAADAAAAEgAAAAAAAAAAewDXt8cBQGeVgRqR2+DijnP/4kDBS9Uz5/2QKPOot+kAAAASAAAAAAAAAAD/tKnGkQxXfeleS2X5k/ncX69fam/gJ3B1kM50DDtn+QAAAAoAAAAAAAAAAAAAAAEqBfIA',
  },
  burn: {
    topic1: 'AAAADwAAAARidXJu',
    value:
      'AAAAEAAAAAEAAAADAAAAEgAAAAAAAAAAewDXt8cBQGeVgRqR2+DijnP/4kDBS9Uz5/2QKPOot+kAAAASAAAAAAAAAAD/tKnGkQxXfeleS2X5k/ncX69fam/gJ3B1kM50DDtn+QAAAAoAAAAAAAAAAAAAAAAAD0JA',
  },
  fees: {
    topic1: 'AAAADwAAAARmZWVz',
    value:
      'AAAAEAAAAAEAAAACAAAACgAAAAAAAAAAAAAAAAX14QAAAAAKAAAAAAAAAAAAAAAAAvrwgA==',
  },
  pause: {
    topic1: 'AAAADwAAAAVwYXVzZQAAAA==',
    value:
      'AAAAEAAAAAEAAAABAAAAEgAAAAAAAAAA/7SpxpEMV33pXktl+ZP53F+vX2pv4CdwdZDOdAw7Z/k=',
  },
  unpause: {
    topic1: 'AAAADwAAAAd1bnBhdXNlAA==',
    value:
      'AAAAEAAAAAEAAAABAAAAEgAAAAAAAAAA/7SpxpEMV33pXktl+ZP53F+vX2pv4CdwdZDOdAw7Z/k=',
  },
  adm_upd: {
    topic1: 'AAAADwAAAAdhZG1fdXBkAA==',
    value:
      'AAAAEAAAAAEAAAACAAAAEgAAAAAAAAAA/7SpxpEMV33pXktl+ZP53F+vX2pv4CdwdZDOdAw7Z/kAAAASAAAAAAAAAAB7ANe3xwFAZ5WBGpHb4OKOc//iQMFL1TPn/ZAo86i36Q==',
  },
} as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRaw(key: keyof typeof XDR, overrides: Partial<RpcEventResponse> = {}): RpcEventResponse {
  return {
    id: `evt-${key}`,
    type: 'contract',
    ledger: 1000,
    ledgerClosedAt: '2026-07-22T18:00:00Z',
    contractId: 'CFACTORY',
    pagingToken: `tok-${key}`,
    inSuccessfulContractCall: true,
    txHash: `txhash-${key}`,
    topic: [FACTORY_TOPIC, XDR[key].topic1],
    value: XDR[key].value,
    ...overrides,
  }
}

// ── CONTRACT_TOPIC_MAP completeness ──────────────────────────────────────────

describe('CONTRACT_TOPIC_MAP', () => {
  const EXPECTED_TOPICS = [
    'init',
    'created',
    'meta',
    'mint',
    'burn',
    'fees',
    'pause',
    'unpause',
    'adm_upd',
    'wl_add',
    'wl_rm',
    'wl_tog',
  ] as const

  it('contains exactly the twelve contract topics', () => {
    expect(Object.keys(CONTRACT_TOPIC_MAP).sort()).toEqual([...EXPECTED_TOPICS].sort())
  })

  it('maps adm_upd to adm_upd (not admin_update)', () => {
    expect(CONTRACT_TOPIC_MAP['adm_upd']).toBe('adm_upd')
  })

  it('does NOT contain the legacy admin_update key', () => {
    expect(CONTRACT_TOPIC_MAP).not.toHaveProperty('admin_update')
  })
})

// ── parseRpcEvent – common behaviour ─────────────────────────────────────────

describe('parseRpcEvent – edge cases', () => {
  it('returns null when topic array is empty', async () => {
    const raw = makeRaw('init', { topic: [] })
    expect(await parseRpcEvent(raw)).toBeNull()
  })

  it('returns null when topic array has fewer than 2 entries', async () => {
    const raw = makeRaw('init', { topic: [FACTORY_TOPIC] })
    expect(await parseRpcEvent(raw)).toBeNull()
  })

  it('returns null for an unrecognised topic (e.g. admin_update)', async () => {
    // The old, incorrect topic string that used to be in the frontend
    const unknownTopic = 'AAAADwAAAAxhZG1pbl91cGRhdGU=' // scvSymbol("admin_update")
    const raw = makeRaw('adm_upd', { topic: [FACTORY_TOPIC, unknownTopic] })
    expect(await parseRpcEvent(raw)).toBeNull()
  })

  it('returns null when the XDR value is malformed', async () => {
    const raw = makeRaw('init', { value: 'not-valid-base64!!!' })
    expect(await parseRpcEvent(raw)).toBeNull()
  })
})

// ── parseRpcEvent – init ──────────────────────────────────────────────────────

describe('parseRpcEvent – init', () => {
  it('decodes an init event', async () => {
    const result = await parseRpcEvent(makeRaw('init'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('init')
    expect(result!.data.admin).toBe(ADDR1)
    expect(result!.txHash).toBe('txhash-init')
    expect(result!.ledger).toBe(1000)
    expect(result!.timestamp).toBeGreaterThan(0)
  })
})

// ── parseRpcEvent – created ───────────────────────────────────────────────────

describe('parseRpcEvent – created', () => {
  it('decodes a created event', async () => {
    const result = await parseRpcEvent(makeRaw('created'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('created')
    expect(result!.data.tokenAddress).toBe(ADDR2)
    expect(result!.data.creator).toBe(ADDR1)
    expect(result!.data.name).toBe('MyToken')
    expect(result!.data.symbol).toBe('MTK')
  })
})

// ── parseRpcEvent – meta ──────────────────────────────────────────────────────

describe('parseRpcEvent – meta', () => {
  it('decodes a meta event', async () => {
    const result = await parseRpcEvent(makeRaw('meta'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('meta')
    expect(result!.data.tokenAddress).toBe(ADDR2)
    expect(result!.data.metadataUri).toBe(
      'ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
    )
  })
})

// ── parseRpcEvent – mint ──────────────────────────────────────────────────────

describe('parseRpcEvent – mint', () => {
  it('decodes a mint event', async () => {
    const result = await parseRpcEvent(makeRaw('mint'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('mint')
    expect(result!.data.tokenAddress).toBe(ADDR2)
    expect(result!.data.to).toBe(ADDR1)
    expect(result!.data.amount).toBe('5000000000')
  })
})

// ── parseRpcEvent – burn ──────────────────────────────────────────────────────

describe('parseRpcEvent – burn', () => {
  it('decodes a burn event', async () => {
    const result = await parseRpcEvent(makeRaw('burn'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('burn')
    expect(result!.data.tokenAddress).toBe(ADDR2)
    expect(result!.data.from).toBe(ADDR1)
    expect(result!.data.amount).toBe('1000000')
  })
})

// ── parseRpcEvent – fees ──────────────────────────────────────────────────────

describe('parseRpcEvent – fees', () => {
  it('decodes a fees event', async () => {
    const result = await parseRpcEvent(makeRaw('fees'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('fees')
    expect(result!.data.baseFee).toBe('100000000')
    expect(result!.data.metadataFee).toBe('50000000')
  })
})

// ── parseRpcEvent – pause ─────────────────────────────────────────────────────

describe('parseRpcEvent – pause', () => {
  it('decodes a pause event', async () => {
    const result = await parseRpcEvent(makeRaw('pause'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('pause')
    expect(result!.data.admin).toBe(ADDR1)
  })
})

// ── parseRpcEvent – unpause ───────────────────────────────────────────────────

describe('parseRpcEvent – unpause', () => {
  it('decodes an unpause event', async () => {
    const result = await parseRpcEvent(makeRaw('unpause'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('unpause')
    expect(result!.data.admin).toBe(ADDR1)
  })
})

// ── parseRpcEvent – adm_upd (THE KEY REGRESSION TEST) ────────────────────────

describe('parseRpcEvent – adm_upd (admin rotation)', () => {
  /**
   * This is the regression test for the adm_upd vs admin_update mismatch.
   *
   * Before the fix, the frontend EVENT_TOPICS contained 'admin_update' while
   * the contract emits symbol_short!("adm_upd").  The decoded topic 'adm_upd'
   * was not in the allow-list, so parseRpcEvent returned null and every
   * admin-rotation event was silently dropped from Transaction History and
   * CSV exports.
   */
  it('decodes an adm_upd event — the critical admin-rotation regression', async () => {
    const result = await parseRpcEvent(makeRaw('adm_upd'))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('adm_upd')
    expect(result!.data.currentAdmin).toBe(ADDR1)
    expect(result!.data.newAdmin).toBe(ADDR2)
  })

  it('preserves both admin addresses in the data payload', async () => {
    const result = await parseRpcEvent(makeRaw('adm_upd'))
    // Both must be present and distinct — this is the information that
    // users and auditors need to audit who controls the factory.
    expect(result!.data.currentAdmin).not.toBe(result!.data.newAdmin)
    expect(result!.data.currentAdmin).toBeTruthy()
    expect(result!.data.newAdmin).toBeTruthy()
  })

  it('returns null for the legacy admin_update topic string (no regression back)', async () => {
    // Verify that the raw string "admin_update" is never silently accepted
    const legacyTopic = 'AAAADwAAAAxhZG1pbl91cGRhdGU=' // scvSymbol("admin_update")
    const raw = makeRaw('adm_upd', { topic: [FACTORY_TOPIC, legacyTopic] })
    expect(await parseRpcEvent(raw)).toBeNull()
  })
})

// ── CSV serialization includes admin rotation ─────────────────────────────────

describe('adm_upd CSV serialization', () => {
  /**
   * Verify that once an adm_upd event is parsed, serializeTransactionsToCSV
   * would capture it.  We test the data shape because the CSV util operates
   * on TransactionHistoryItem (Horizon op model), but we can verify the parsed
   * event has the right shape to be mapped to a CSV row.
   */
  it('parsed adm_upd event has currentAdmin and newAdmin in data', async () => {
    const result = await parseRpcEvent(makeRaw('adm_upd'))
    expect(result).not.toBeNull()
    // These fields must be present for a UI row to show both addresses
    expect(Object.keys(result!.data)).toContain('currentAdmin')
    expect(Object.keys(result!.data)).toContain('newAdmin')
  })
})
