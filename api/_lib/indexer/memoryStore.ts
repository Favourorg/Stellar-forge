/**
 * In-memory `TokenStore`.
 *
 * Backs the ingest and API unit tests, and serves as the local-development
 * store when no `POSTGRES_URL` is configured. Deliberately not production-safe:
 * state is per-process and lost on restart, exactly like the in-memory fallback
 * in `api/_lib/rateLimit.ts`.
 */

import {
  EMPTY_STATE,
  MAX_PAGE_LIMIT,
  type IndexedToken,
  type IndexerState,
  type ListTokensOptions,
  type ListTokensResult,
  type TokenStore,
} from './types'

export class MemoryTokenStore implements TokenStore {
  private tokens = new Map<string, IndexedToken>()
  private state: IndexerState = { ...EMPTY_STATE }

  async upsertTokens(tokens: IndexedToken[]): Promise<void> {
    for (const token of tokens) {
      const existing = this.tokens.get(token.address)
      // Preserve a metadata URI already learned from a `meta` event when a
      // later backfill pass re-reads the token, since `get_token_info` does
      // not carry it.
      this.tokens.set(token.address, {
        ...token,
        metadataUri: token.metadataUri ?? existing?.metadataUri ?? null,
      })
    }
  }

  async setMetadataUri(address: string, metadataUri: string): Promise<void> {
    const existing = this.tokens.get(address)
    if (existing) this.tokens.set(address, { ...existing, metadataUri })
  }

  async getToken(address: string): Promise<IndexedToken | null> {
    return this.tokens.get(address) ?? null
  }

  async listTokens(options: ListTokensOptions): Promise<ListTokensResult> {
    const limit = Math.min(Math.max(options.limit, 1), MAX_PAGE_LIMIT)

    const rows = [...this.tokens.values()]
      .filter((t) => (options.creator ? t.creator === options.creator : true))
      .filter((t) => (options.cursor === undefined ? true : t.tokenIndex < options.cursor))
      .sort((a, b) => b.tokenIndex - a.tokenIndex)

    // Read one extra row to learn whether another page exists without a
    // second COUNT query.
    const page = rows.slice(0, limit)
    const hasMore = rows.length > limit
    const last = page[page.length - 1]

    return {
      tokens: page,
      nextCursor: hasMore && last ? String(last.tokenIndex) : null,
    }
  }

  async countTokens(): Promise<number> {
    return this.tokens.size
  }

  async presentIndices(indices: number[]): Promise<Set<number>> {
    const present = new Set<number>()
    const wanted = new Set(indices)
    for (const token of this.tokens.values()) {
      if (wanted.has(token.tokenIndex)) present.add(token.tokenIndex)
    }
    return present
  }

  async getState(): Promise<IndexerState> {
    return { ...this.state }
  }

  async saveState(patch: Partial<IndexerState>): Promise<void> {
    this.state = { ...this.state, ...patch }
  }
}
