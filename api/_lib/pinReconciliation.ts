/**
 * IPFS pin reconciliation — comparing Pinata's pin list against on-chain
 * metadata events to identify and reclaim orphaned pins.
 *
 * Every upload pins two CIDs (image + metadata JSON). If the follow-up
 * `set_metadata` transaction is rejected by the user or fails, those pins are
 * orphaned. The frontend handles the common case (unpins on provably-failed
 * transactions), but this reconciliation job is the safety net for:
 *
 * 1. Unconfirmed transactions (network timeout — the pins may still be valid)
 * 2. Browser crashes after upload but before the transaction could be attempted
 * 3. Manual IPFS uploads that bypass the StellarForge UI
 * 4. Pin leakage from any other code path
 */

import { PINATA_API_URL, pinataHeaders } from './pinata'

/** Grace window: pins younger than this are considered "in-flight" and never
 *  automatically reclaimed. Mirrors the JWT expiry (5 min) + generous buffer. */
export const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Interface for a single pin returned by Pinata's pinList endpoint. */
export interface PinataPin {
  id: string
  ipfs_pin_hash: string
  date_pinned: string // ISO-8601 string from Pinata
  metadata: Record<string, unknown>
}

/** Interface for the pinList API response. */
export interface PinListResponse {
  count: number
  rows: PinataPin[]
}

/** Result of one reconciliation run. */
export interface ReconciliationResult {
  /** Total pins checked against the on-chain reference set. */
  checked: number
  /** Pins that were present on-chain and preserved. */
  preserved: number
  /** Pins that were successfully unpinned. */
  cleaned: number
  /** Pins that were orphaned but unpin failed. */
  errors: number
  /** First error message, if any. */
  errorMessage: string | null
  /** Grace window in ms used for this run. */
  graceMs: number
}

/**
 * List all pins from the Pinata account, handling pagination.
 *
 * @param pageLimit Max rows per page (Pinata max: 1000)
 */
export async function listAllPins(pageLimit = 1000): Promise<PinataPin[]> {
  const allPins: PinataPin[] = []
  let pageOffset = 0
  let totalCount = 0

  do {
    const headers = pinataHeaders({ 'Content-Type': 'application/json' })
    const response = await fetch(`${PINATA_API_URL}/data/pinList`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        status: 'pinned',
        pageLimit,
        pageOffset,
      }),
    })

    if (!response.ok) {
      throw new Error(`Pinata pinList query failed (HTTP ${response.status})`)
    }

    const data = (await response.json()) as PinListResponse
    allPins.push(...data.rows)
    totalCount = data.count
    pageOffset += pageLimit
  } while (pageOffset < totalCount)

  return allPins
}

/**
 * Determine which pins are orphaned past the grace window.
 *
 * Pure function — no side effects, fully testable.
 *
 * @param pins       All pins from the Pinata account
 * @param cidInUse   Set of CIDs that are referenced by on-chain metadata events
 * @param now        Current timestamp (ms since epoch) — injectable for tests
 * @param graceMs    Grace window in ms
 * @returns          Pins to unpin and pins to preserve
 */
export function classifyPins(
  pins: PinataPin[],
  cidInUse: Set<string>,
  now: number = Date.now(),
  graceMs: number = GRACE_WINDOW_MS,
): { toUnpin: string[]; preserved: number } {
  const toUnpin: string[] = []
  let preserved = 0

  for (const pin of pins) {
    const cid = pin.ipfs_pin_hash
    if (cidInUse.has(cid)) {
      // Referenced by at least one on-chain metadata event — must keep.
      preserved++
      continue
    }

    const pinnedAt = new Date(pin.date_pinned).getTime()
    if (Number.isNaN(pinnedAt)) {
      // Unparseable date — preserve to be safe.
      preserved++
      continue
    }

    if (now - pinnedAt <= graceMs) {
      // Within grace window — may be an in-flight upload.
      preserved++
      continue
    }

    // Older than grace window and not referenced on-chain — orphan.
    toUnpin.push(cid)
  }

  return { toUnpin, preserved }
}

/**
 * Unpin a list of CIDs via the Pinata unpin API, best-effort.
 *
 * @returns {cleaned, errors, errorMessage}
 */
export async function unpinCids(cids: string[]): Promise<{
  cleaned: number
  errors: number
  errorMessage: string | null
}> {
  let cleaned = 0
  let errors = 0
  let errorMessage: string | null = null

  if (cids.length === 0) return { cleaned: 0, errors: 0, errorMessage: null }

  const headers = pinataHeaders()

  for (const cid of cids) {
    try {
      const response = await fetch(`${PINATA_API_URL}/pinning/unpin/${cid}`, {
        method: 'DELETE',
        headers,
      })
      // 404 means the CID was already gone — acceptable.
      if (response.ok || response.status === 404) {
        cleaned++
      } else {
        errors++
        errorMessage = `Unpin ${cid} failed (HTTP ${response.status})`
      }
    } catch {
      errors++
      errorMessage = `Unpin ${cid} threw a network error`
    }
  }

  return { cleaned, errors, errorMessage }
}

/**
 * Extract IPFS CIDs from a set of metadata URIs (which are in `ipfs://<cid>`
 * format).
 */
export function extractCidsFromMetadataUris(uris: string[]): Set<string> {
  const cids = new Set<string>()
  for (const uri of uris) {
    if (typeof uri !== 'string' || uri.length === 0) continue
    // Both `ipfs://<cid>` and bare `<cid>` are allowed.
    const m = uri.match(/^ipfs:\/\/(.+)$/)
    if (m) {
      cids.add(m[1])
    } else {
      // May be a bare CID — add as-is if it looks like one.
      if (/^[a-zA-Z0-9]{44,59}$/.test(uri)) {
        cids.add(uri)
      }
    }
  }
  return cids
}

/**
 * Run a full reconciliation cycle: list pins, fetch on-chain metadata URIs,
 * classify, and unpin orphans.
 *
 * This is the high-level function called by the cron handler.
 *
 * @param getMetadataUris  Callback that returns all on-chain metadata URIs
 *                         (injectable for tests; in production backed by the
 *                         indexer store)
 * @param now              Overrideable timestamp for testing
 */
export async function runReconciliation(
  getMetadataUris: () => Promise<string[]>,
  now: number = Date.now(),
): Promise<ReconciliationResult> {
  const graceMs = GRACE_WINDOW_MS

  // 1. List all pins
  let pins: PinataPin[]
  try {
    pins = await listAllPins()
  } catch (err) {
    return {
      checked: 0,
      preserved: 0,
      cleaned: 0,
      errors: 0,
      errorMessage: `Failed to list pins: ${err instanceof Error ? err.message : String(err)}`,
      graceMs,
    }
  }

  // 2. Get on-chain metadata URIs
  let metadataUris: string[]
  try {
    metadataUris = await getMetadataUris()
  } catch (err) {
    return {
      checked: pins.length,
      preserved: pins.length,
      cleaned: 0,
      errors: 0,
      errorMessage: `Failed to query on-chain metadata: ${err instanceof Error ? err.message : String(err)}`,
      graceMs,
    }
  }

  const cidInUse = extractCidsFromMetadataUris(metadataUris)

  // 3. Classify
  const { toUnpin, preserved } = classifyPins(pins, cidInUse, now, graceMs)

  // 4. Unpin orphans
  const { cleaned, errors, errorMessage } = await unpinCids(toUnpin)

  // 5. Log metrics about how many pins were preserved (in-flight / on-chain)
  //    by the frontend unpin code vs cleaned by reconciliation.
  //    This is surfaced in the cron response JSON.

  return {
    checked: pins.length,
    preserved,
    cleaned,
    errors,
    errorMessage,
    graceMs,
  }
}
