/**
 * Build-time script: fetches all token addresses from the factory contract's
 * `created` events and writes public/sitemap.xml.
 *
 * Usage:
 *   npx tsx scripts/generateSitemap.ts
 *
 * Reads environment variables:
 *   VITE_FACTORY_CONTRACT_ID  – required
 *   VITE_NETWORK              – optional, defaults to 'testnet'
 *   VITE_SITE_URL             – optional, defaults to 'https://stellarforge.app'
 */

import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────────────────

const NETWORK = process.env.VITE_NETWORK ?? 'testnet'
const FACTORY_CONTRACT_ID = process.env.VITE_FACTORY_CONTRACT_ID ?? ''
const SITE_URL = (process.env.VITE_SITE_URL ?? 'https://stellarforge.app').replace(/\/$/, '')

const RPC_URLS: Record<'testnet' | 'mainnet', string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://soroban-mainnet.stellar.org',
}

// ── Fetch token addresses from factory events ─────────────────────────────────

async function fetchTokenAddresses(): Promise<string[]> {
  if (!FACTORY_CONTRACT_ID || FACTORY_CONTRACT_ID.startsWith('CXXX')) {
    console.warn('generateSitemap: VITE_FACTORY_CONTRACT_ID not set — skipping token URLs')
    return []
  }

  if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') {
    console.warn(`generateSitemap: no public RPC for network "${NETWORK}" — skipping token URLs`)
    return []
  }

  const rpcUrl = RPC_URLS[NETWORK]
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getEvents',
    params: {
      filters: [{ type: 'contract', contractIds: [FACTORY_CONTRACT_ID] }],
      pagination: { limit: 200 },
    },
  })

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (!res.ok) {
    console.warn(`generateSitemap: RPC request failed (${res.status}) — skipping token URLs`)
    return []
  }

  const json = (await res.json()) as {
    result?: { events?: { topic?: string[]; value?: string }[] }
  }

  const addresses: string[] = []
  for (const event of json.result?.events ?? []) {
    // The first topic entry encodes the event type as a Symbol SCVal.
    // We decode by checking the raw XDR string for "created" events, then
    // extract the token address from the event value map.
    if (!event.topic?.[0]?.includes('created')) continue
    // The value is an XDR-encoded map; parse it via the stellar-sdk.
    try {
      const { xdr, scValToNative } = await import('stellar-sdk')
      const val = scValToNative(xdr.ScVal.fromXDR(event.value ?? '', 'base64'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const addr = (val as any)?.token_address?.toString()
      if (addr && !addresses.includes(addr)) addresses.push(addr)
    } catch {
      // skip unparseable events
    }
  }

  return addresses
}

// ── Write sitemap.xml ─────────────────────────────────────────────────────────

function buildSitemap(tokenAddresses: string[]): string {
  const today = new Date().toISOString().slice(0, 10)

  const staticUrls = [
    `  <url>\n    <loc>${SITE_URL}/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    `  <url>\n    <loc>${SITE_URL}/explorer</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`,
  ]

  const tokenUrls = tokenAddresses.map(
    (addr) =>
      `  <url>\n    <loc>${SITE_URL}/token/${addr}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
  )

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...staticUrls,
    ...tokenUrls,
    '</urlset>',
  ].join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────────────

const addresses = await fetchTokenAddresses()
const sitemap = buildSitemap(addresses)
const outPath = resolve(__dirname, '../public/sitemap.xml')
writeFileSync(outPath, sitemap + '\n')
console.log(
  `generateSitemap: wrote ${1 + 1 + addresses.length} URLs to public/sitemap.xml (${addresses.length} token pages)`,
)
