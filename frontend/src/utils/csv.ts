/**
 * CSV serialization utilities for exporting transaction history.
 *
 * ── Formula-injection guard ─────────────────────────────────────────────────
 * RFC 4180 specifies how to properly quote/escape CSV fields (embedded quotes,
 * commas, newlines), but compliance with RFC 4180 does NOT prevent spreadsheet
 * formula injection (CWE-1236 / OWASP CSV injection).
 *
 * Excel, LibreOffice Calc, and Google Sheets all treat a cell starting with
 * one of the following characters as a formula to evaluate on open,
 * regardless of whether the field is CSV-quoted:
 *   =  (equals)
 *   +  (plus)
 *   -  (minus)
 *   @  (at)
 *   \t (tab)
 *   \r (carriage return)
 *
 * Quoting only affects how the CSV parser splits fields; it does not prevent
 * the spreadsheet application from interpreting the content as a formula after
 * parsing. The two layers are easy to conflate, which is why this distinction
 * is documented here.
 *
 * The standard mitigation (recommended by OWASP) is to prefix any value that
 * starts with a formula-trigger character with a single quote (') before the
 * field is optionally wrapped in double quotes. Spreadsheets display a cell
 * beginning with a lone single quote as literal text, not a formula.
 *
 * @see https://owasp.org/www-community/attacks/CSV_Injection
 */

import type { ContractEvent } from '../types'

/**
 * Characters that, when present as the first character of a CSV cell value,
 * cause mainstream spreadsheet applications to interpret the cell as a formula.
 * Per OWASP CSV Injection guidance.
 */
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/

/**
 * Serialize a single CSV field value.
 *
 * 1. If the value starts with a formula-trigger character, neutralize it by
 *    prefixing with a single quote (') — this is the OWASP-recommended
 *    mitigation for CWE-1236.
 * 2. Apply RFC 4180 quoting: if the value contains a double-quote, comma,
 *    newline, or carriage return, wrap it in double quotes and escape any
 *    embedded double quotes by doubling them.
 */
function escapeCsvField(value: unknown): string {
  let str = String(value ?? '')

  // ── Formula-injection guard (CWE-1236) ────────────────────────────────
  // Prefix with single quote to prevent spreadsheet formula execution.
  // This MUST happen before RFC 4180 quoting because the spreadsheet
  // application evaluates the cell content after CSV parsing is complete.
  if (FORMULA_TRIGGERS.test(str)) {
    str = "'" + str
  }

  // ── RFC 4180 quoting ──────────────────────────────────────────────────
  // If the field contains a double-quote, comma, newline, or carriage
  // return, wrap it in double quotes and escape embedded double quotes.
  if (
    str.includes('"') ||
    str.includes(',') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    str = '"' + str.replace(/"/g, '""') + '"'
  }

  return str
}

/**
 * CSV column headers for the exported transaction history.
 */
const CSV_HEADERS = [
  'Type',
  'Token',
  'Creator',
  'Timestamp',
  'Tx Hash',
  'To',
  'From',
  'Amount',
  'URI',
  'Base Fee',
  'Metadata Fee',
]

/**
 * Serialize an array of contract events into a CSV-formatted string.
 *
 * The CSV output is:
 * - RFC 4180 compliant (proper quoting of embedded quotes, commas, newlines)
 * - Protected against spreadsheet formula injection (CWE-1236 / OWASP CSV Injection)
 * - Headers-only if the events array is empty
 *
 * @param events - Contract events to serialize.
 * @returns A CSV string (including BOM for Excel compatibility).
 */
export function serializeTransactionsToCSV(events: ContractEvent[]): string {
  // Include a UTF-8 BOM (\uFEFF) so Excel correctly detects the encoding.
  const rows: string[] = ['\uFEFF' + CSV_HEADERS.join(',')]

  for (const event of events) {
    const row = [
      escapeCsvField(event.type),
      escapeCsvField(event.data.tokenAddress ?? ''),
      escapeCsvField(event.data.creator ?? ''),
      escapeCsvField(event.timestamp ? new Date(event.timestamp * 1000).toISOString() : ''),
      escapeCsvField(event.txHash),
      escapeCsvField(event.data.to ?? ''),
      escapeCsvField(event.data.from ?? ''),
      escapeCsvField(event.data.amount ?? ''),
      escapeCsvField(event.data.metadataUri ?? ''),
      escapeCsvField(event.data.baseFee ?? ''),
      escapeCsvField(event.data.metadataFee ?? ''),
    ]
    rows.push(row.join(','))
  }

  return rows.join('\n')
}
