import { describe, it, expect } from 'vitest'
import { CONTRACT_ERROR_MESSAGES, parseContractError } from '../utils/contractErrors'

const contractError = (code: number) => new Error(`HostError: Error(Contract, ${code})`)

describe('parseContractError', () => {
  describe('known contract error codes', () => {
    // Codes 1-7 are explicitly required by the task; the rest are covered for completeness.
    for (const [codeStr, message] of Object.entries(CONTRACT_ERROR_MESSAGES)) {
      const code = Number(codeStr)
      it(`maps code ${code} to its message`, () => {
        expect(parseContractError(contractError(code)).message).toBe(message)
      })
    }

    it('maps each of the core codes 1-7 to the expected string', () => {
      const expected: Record<number, string> = {
        1: 'Insufficient fee payment. Please increase the fee amount.',
        2: 'Unauthorized. You do not have permission to perform this action.',
        3: 'Invalid parameters provided.',
        4: 'Token not found.',
        5: 'Metadata has already been set for this token.',
        6: 'Contract is already initialized.',
        7: 'Burn amount exceeds your token balance.',
      }
      for (const [code, message] of Object.entries(expected)) {
        expect(parseContractError(contractError(Number(code))).message).toBe(message)
      }
    })

    it('parses a code from a full Soroban result XDR style message', () => {
      const err = new Error('transaction simulation failed: Error(Contract, 4)')
      // "simulation"/"insufficient" keyword branches must not pre-empt a real contract code.
      expect(parseContractError(err).message).toBe(CONTRACT_ERROR_MESSAGES[4])
    })
  })

  describe('unknown contract error codes', () => {
    it('returns a non-empty generic fallback including the code', () => {
      const result = parseContractError(contractError(999))
      expect(result.message.length).toBeGreaterThan(0)
      expect(result.message).toContain('999')
      expect(result.message).not.toBe('')
    })

    it('falls back for code 0 (not in the map)', () => {
      const result = parseContractError(contractError(0))
      expect(result.message).toContain('0')
      expect(result.message.length).toBeGreaterThan(0)
    })
  })

  describe('wallet and network keyword branches', () => {
    it('detects a user-declined rejection', () => {
      expect(parseContractError(new Error('User declined access')).message).toContain('rejected')
    })

    it('detects insufficient funds', () => {
      expect(parseContractError(new Error('op_underfunded')).message).toContain(
        'Insufficient funds',
      )
    })

    it('detects a network timeout', () => {
      expect(parseContractError(new Error('request timed out')).message).toContain(
        'Network timeout',
      )
    })
  })

  describe('malformed and non-standard input does not throw', () => {
    const cases: unknown[] = [
      '',
      'random text with no code',
      'Error(Contract, )',
      'Error(Contract, abc)',
      'Error(Contract,)',
      'Error(Contract',
      null,
      undefined,
      42,
      {},
      [],
      { message: 'plain object' },
      Symbol('s'),
    ]

    for (const input of cases) {
      it(`returns an Error without throwing for ${String(input)}`, () => {
        let result: Error
        expect(() => {
          result = parseContractError(input)
        }).not.toThrow()
        expect(result!).toBeInstanceOf(Error)
        expect(typeof result!.message).toBe('string')
      })
    }

    it('preserves the original Error instance when nothing matches', () => {
      const original = new Error('totally unrelated failure')
      expect(parseContractError(original)).toBe(original)
    })
  })
})
