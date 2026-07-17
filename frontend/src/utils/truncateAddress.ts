/**
 * Truncates a Stellar address (or any long string) to first 6 + last 4 chars.
 * Returns the original string unchanged if it is shorter than or equal to
 * startChars + endChars.
 *
 * Pure function — no side effects, safe to use anywhere.
 */
export function truncateAddress(address: string, startChars = 6, endChars = 4): string {
  if (address.length <= startChars + endChars) return address
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`
}
