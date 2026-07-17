import { describe, it, expect } from 'vitest'
import { serializeTransactionsToCSV } from '../utils/csv'
import type { ContractEvent } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ContractEvent> = {}): ContractEvent {
  return {
    id: 'evt-1',
    type: 'token_created',
    ledger: 12345,
    timestamp: 1773934080, // 2026-03-19T15:28:00Z
    txHash: 'abc123def456',
    data: {
      tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      creator: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    },
    ...overrides,
  }
}

// ── Formula-injection guard tests (CWE-1236) ──────────────────────────────────

describe('formula injection guard', () => {
  it('neutralizes a value starting with =', () => {
    const event = makeEvent({ txHash: '=1+1' })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain("'=1+1")
  })

  it('neutralizes a value starting with +', () => {
    const event = makeEvent({
      data: { tokenAddress: '+SUM(A1:A10)', creator: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' },
    })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain("'+SUM(A1:A10)")
  })

  it('neutralizes a value starting with -', () => {
    const event = makeEvent({
      data: { tokenAddress: '-1+2', creator: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' },
    })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain("'-1+2")
  })

  it('neutralizes a value starting with @', () => {
    const event = makeEvent({ txHash: '@SUM(A1:A9)' })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain("'@SUM(A1:A9)")
  })

  it('neutralizes a value starting with tab', () => {
    const event = makeEvent({
      data: { tokenAddress: '\t=HYPERLINK("http://evil.com")', creator: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' },
    })
    const csv = serializeTransactionsToCSV([event])
    // After formula guard: '\t=HYPERLINK("http://evil.com")'
    // After RFC 4180 quoting: "'\t=HYPERLINK(""http://evil.com"")"
    expect(csv).toContain("'\t=HYPERLINK")
  })

  it('neutralizes a value starting with carriage return', () => {
    const event = makeEvent({
      type: 'tokens_minted',
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        to: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        amount: '\r100',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    // After formula guard: '\r100'
    // After RFC 4180 quoting: "'\r100" (wrapped in quotes because contains \r)
    expect(csv).toContain("'\r100")
  })

  it('does NOT add a prefix to normal values', () => {
    const event = makeEvent()
    const csv = serializeTransactionsToCSV([event])
    // A normal Stellar address should NOT be prefixed with '
    expect(csv).toContain('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN')
    expect(csv).not.toContain("'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")
  })

  it('does NOT add prefix to a value starting with a letter', () => {
    const event = makeEvent({ txHash: 'normal-hash-value' })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('normal-hash-value')
    expect(csv).not.toContain("'normal-hash-value")
  })
})

// ── RFC 4180 compliance tests ─────────────────────────────────────────────────

describe('RFC 4180 quoting', () => {
  it('wraps a field containing a comma in double quotes', () => {
    const event = makeEvent({
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        creator: 'addr1,addr2',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('"addr1,addr2"')
  })

  it('escapes embedded double quotes by doubling them', () => {
    const event = makeEvent({
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        creator: 'say "hello"',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('"say ""hello"""')
  })

  it('wraps a field containing a newline in double quotes', () => {
    const event = makeEvent({
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        creator: 'line1\nline2',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    // The field should be wrapped in double quotes with the newline inside
    expect(csv).toContain('"line1\nline2"')
  })

  it('handles a field with both formula trigger and comma correctly', () => {
    const event = makeEvent({
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        creator: '=HYPERLINK("http://evil.com")',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    // After formula guard: "'=HYPERLINK("http://evil.com")"
    // After RFC 4180: "'=HYPERLINK(""http://evil.com"")" — and since it contains commas/quotes it gets outer quotes
    // Actually: after formula guard it starts with ', which doesn't match triggers (it's ' not =/+/-/@/\t/\r)
    // Wait! After the guard we add ' prefix, making the value start with '.
    // Then RFC 4180: the value "'=HYPERLINK("http://evil.com")" contains commas AND double quotes
    // " is escaped to "", then wrapped in double quotes
    // Result: "'=HYPERLINK(""http://evil.com"")"
    // But wait - does it actually contain a comma? "http://evil.com" doesn't have commas.
    // It contains double quotes though. So it gets wrapped in quotes with escaped inner quotes.
    // Final: "'=HYPERLINK(""http://evil.com"")"
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain('""http://evil.com""')
  })
})

// ── Header and structure tests ────────────────────────────────────────────────

describe('CSV structure', () => {
  it('includes a BOM at the beginning for Excel compatibility', () => {
    const csv = serializeTransactionsToCSV([])
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
  })

  it('outputs headers when given an empty array', () => {
    const csv = serializeTransactionsToCSV([])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('\uFEFFType,Token,Creator,Timestamp,Tx Hash,To,From,Amount,URI,Base Fee,Metadata Fee')
    expect(lines.length).toBe(1) // only header
  })

  it('outputs one data row per event', () => {
    const events = [makeEvent(), makeEvent({ id: 'evt-2', txHash: 'xyz789' })]
    const csv = serializeTransactionsToCSV(events)
    const lines = csv.split('\n')
    expect(lines.length).toBe(3) // header + 2 rows
  })

  it('includes timestamp formatted as ISO string', () => {
    const event = makeEvent({ timestamp: 1773934080 })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('2026-03-19T15:28:00.000Z')
  })
})

// ── All event types produce valid CSV ─────────────────────────────────────────

describe('all event types', () => {
  it('serializes a token_created event', () => {
    const event = makeEvent()
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('token_created')
  })

  it('serializes a tokens_minted event', () => {
    const event = makeEvent({
      type: 'tokens_minted',
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        to: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        amount: '5000000000',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('tokens_minted')
    expect(csv).toContain('5000000000')
  })

  it('serializes a tokens_burned event', () => {
    const event = makeEvent({
      type: 'tokens_burned',
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        from: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        amount: '1000000',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('tokens_burned')
    expect(csv).toContain('1000000')
  })

  it('serializes a metadata_set event', () => {
    const event = makeEvent({
      type: 'metadata_set',
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        metadataUri: 'ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('metadata_set')
    expect(csv).toContain('ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco')
  })

  it('serializes a fees_updated event', () => {
    const event = makeEvent({
      type: 'fees_updated',
      data: {
        tokenAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        baseFee: '100',
        metadataFee: '50',
      },
    })
    const csv = serializeTransactionsToCSV([event])
    expect(csv).toContain('fees_updated')
    expect(csv).toContain('100')
    expect(csv).toContain('50')
  })
})
