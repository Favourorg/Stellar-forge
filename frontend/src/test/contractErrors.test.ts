import { describe, expect, it } from 'vitest'
import { CONTRACT_ERROR_MESSAGES, parseContractError } from '../utils/contractErrors'

describe('parseContractError', () => {
  it('maps every known contract error code to its user-facing message', () => {
    for (const [rawCode, expectedMessage] of Object.entries(CONTRACT_ERROR_MESSAGES)) {
      const parsed = parseContractError(new Error(`HostError: Error(Contract, ${rawCode})`))

      expect(parsed).toBeInstanceOf(Error)
      expect(parsed.message).toBe(expectedMessage)
    }
  })

  it('returns a non-empty fallback for unknown contract error codes', () => {
    const parsed = parseContractError('transaction failed: Error(Contract, 999)')

    expect(parsed.message).toBe('An unexpected contract error occurred (code 999).')
  })

  it.each([
    'Error(Contract, abc)',
    'Error(Contract)',
    'contract invocation failed',
    '',
    null,
    undefined,
  ])('does not throw for malformed contract error input: %s', (input) => {
    const parsed = parseContractError(input)

    expect(parsed).toBeInstanceOf(Error)
  })
})
