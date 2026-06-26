import { describe, it, expect } from 'vitest'
import { applyFilters } from './tokenFilters'
import type { TokenInfo } from '../types'

const CREATOR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const CREATOR_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF'

const mockTokens: TokenInfo[] = [
  {
    name: 'Alpha Token',
    symbol: 'ALPHA',
    decimals: 7,
    totalSupply: '1000000000',
    creator: CREATOR_A,
    createdAt: 1000000,
    metadataUri: null,
  },
  {
    name: 'Beta Coin',
    symbol: 'BETA',
    decimals: 8,
    totalSupply: '2000000000',
    creator: CREATOR_B,
    createdAt: 2000000,
    metadataUri: 'ipfs://QmBeta',
  },
  {
    name: 'Gamma Token',
    symbol: 'GAMMA',
    decimals: 6,
    totalSupply: '500000000',
    creator: CREATOR_A,
    createdAt: 3000000,
    metadataUri: null,
  },
  {
    name: 'Delta Finance',
    symbol: 'DELTA',
    decimals: 18,
    totalSupply: '10000000000000000000',
    creator: CREATOR_B,
    createdAt: 4000000,
    metadataUri: 'ipfs://QmDelta',
  },
]

describe('applyFilters', () => {
  // ── Search Filter ─────────────────────────────────────────────────────────

  describe('search filter', () => {
    it('filters by token name', () => {
      const result = applyFilters(mockTokens, 'Alpha', '', 'newest')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Alpha Token')
    })

    it('filters by token symbol', () => {
      const result = applyFilters(mockTokens, 'BETA', '', 'newest')
      expect(result).toHaveLength(1)
      expect(result[0].symbol).toBe('BETA')
    })

    it('is case-insensitive', () => {
      const result = applyFilters(mockTokens, 'gamma', '', 'newest')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Gamma Token')
    })

    it('matches partial strings', () => {
      const result = applyFilters(mockTokens, 'Token', '', 'newest')
      expect(result).toHaveLength(2)
      expect(result.map((t) => t.name)).toEqual(['Alpha Token', 'Gamma Token'])
    })

    it('returns all tokens when search is empty', () => {
      const result = applyFilters(mockTokens, '', '', 'newest')
      expect(result).toHaveLength(4)
    })

    it('returns empty array when search matches nothing', () => {
      const result = applyFilters(mockTokens, 'NonExistent', '', 'newest')
      expect(result).toHaveLength(0)
    })
  })

  // ── Creator Filter ────────────────────────────────────────────────────────

  describe('creator filter', () => {
    it('filters tokens by creator address', () => {
      const result = applyFilters(mockTokens, '', CREATOR_A, 'newest')
      expect(result).toHaveLength(2)
      expect(result.map((t) => t.creator)).toEqual([CREATOR_A, CREATOR_A])
    })

    it('is case-insensitive for creator address', () => {
      const result = applyFilters(mockTokens, '', CREATOR_A.toLowerCase(), 'newest')
      expect(result).toHaveLength(2)
    })

    it('matches partial creator address', () => {
      const partialCreator = CREATOR_A.slice(0, 10)
      const result = applyFilters(mockTokens, '', partialCreator, 'newest')
      expect(result).toHaveLength(2)
      expect(
        result.every((t) => t.creator.toLowerCase().includes(partialCreator.toLowerCase())),
      ).toBe(true)
    })

    it('returns empty array when creator matches nothing', () => {
      const result = applyFilters(
        mockTokens,
        '',
        'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF',
        'newest',
      )
      expect(result).toHaveLength(0)
    })

    it('returns all tokens when creator filter is empty', () => {
      const result = applyFilters(mockTokens, '', '', 'newest')
      expect(result).toHaveLength(4)
    })
  })

  // ── Combined Filters ──────────────────────────────────────────────────────

  describe('combined filters', () => {
    it('applies both search and creator filters', () => {
      const result = applyFilters(mockTokens, 'Token', CREATOR_A, 'newest')
      expect(result).toHaveLength(2)
      expect(result.map((t) => t.symbol)).toEqual(['ALPHA', 'GAMMA'])
    })

    it('returns empty when combined filters match nothing', () => {
      const result = applyFilters(mockTokens, 'Alpha', CREATOR_B, 'newest')
      expect(result).toHaveLength(0)
    })
  })

  // ── Sort Order ────────────────────────────────────────────────────────────

  describe('sort order', () => {
    it('keeps newest-first order by default', () => {
      const result = applyFilters(mockTokens, '', '', 'newest')
      // Array order is maintained (newest-first is assumed to be input order)
      expect(result[0].name).toBe('Alpha Token')
    })

    it('sorts by oldest-first when specified', () => {
      const result = applyFilters(mockTokens, '', '', 'oldest')
      expect(result[0].name).toBe('Delta Finance')
      expect(result[result.length - 1].name).toBe('Alpha Token')
    })

    it('sorts alphabetically by name when specified', () => {
      const result = applyFilters(mockTokens, '', '', 'alphabetical')
      expect(result.map((t) => t.name)).toEqual([
        'Alpha Token',
        'Beta Coin',
        'Delta Finance',
        'Gamma Token',
      ])
    })
  })

  // ── Edge Cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles null input gracefully', () => {
      const result = applyFilters(null, '', '', 'newest')
      expect(result).toHaveLength(0)
    })

    it('handles undefined input gracefully', () => {
      const result = applyFilters(undefined, '', '', 'newest')
      expect(result).toHaveLength(0)
    })

    it('handles empty array', () => {
      const result = applyFilters([], '', '', 'newest')
      expect(result).toHaveLength(0)
    })

    it('preserves token immutability', () => {
      const original = [...mockTokens]
      applyFilters(mockTokens, 'Alpha', '', 'newest')
      expect(mockTokens).toEqual(original)
    })

    it('handles all filters combined with sorts', () => {
      const filtered = applyFilters(mockTokens, 'Coin', CREATOR_B, 'alphabetical')
      expect(filtered).toHaveLength(1)
      expect(filtered[0].symbol).toBe('BETA')
    })

    it('handles whitespace as part of search pattern', () => {
      // Note: applyFilters doesn't trim whitespace, so "  Alpha  " won't match "Alpha Token"
      // This test verifies the current behavior
      const result = applyFilters(mockTokens, '  Alpha  ', '', 'newest')
      expect(result).toHaveLength(0)
    })

    it('finds tokens when search pattern matches', () => {
      const result = applyFilters(mockTokens, 'Alpha', '', 'newest')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Alpha Token')
    })
  })
})
