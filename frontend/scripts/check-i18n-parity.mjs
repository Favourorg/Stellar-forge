#!/usr/bin/env node

/**
 * i18n Locale Key Parity Check
 *
 * Loads all locale JSON files, flattens their keys into dot notation,
 * and checks that every key present in en.json (the source of truth)
 * also exists in es.json, fr.json, and pt.json.
 *
 * Usage:
 *   node scripts/check-i18n-parity.mjs       # check all locales against en.json
 *
 * Exit codes:
 *   0 – all locale files are in parity with en.json
 *   1 – one or more locale files are missing keys (CI-blocking)
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = resolve(__dirname, '..', 'src', 'i18n')
const SOURCE_OF_TRUTH = 'en.json'

const LOCALES = ['es.json', 'fr.json', 'pt.json']

/**
 * Flatten a nested object into dot-notation keys.
 *
 * @param {Record<string, unknown>} obj - The nested object
 * @param {string} [prefix=''] - Key prefix for recursion
 * @returns {Record<string, string>} Flattened key-value pairs
 *
 * @example
 * flattenKeys({ a: { b: 'c' } }) // → { 'a.b': 'c' }
 */
function flattenKeys(obj, prefix = '') {
  const result = {}

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenKeys(value, fullKey))
    } else {
      result[fullKey] = String(value)
    }
  }

  return result
}

/**
 * Load and parse a JSON locale file.
 *
 * @param {string} filename - e.g. 'en.json'
 * @returns {Record<string, unknown>} Parsed JSON content
 */
function loadLocale(filename) {
  const filePath = resolve(LOCALES_DIR, filename)
  const raw = readFileSync(filePath, 'utf-8')
  return JSON.parse(raw)
}

/**
 * Pretty-print a grouped list of missing keys.
 *
 * @param {Record<string, string[]>} missingMap - locale → missing keys[]
 */
function printMissing(missingMap) {
  for (const [locale, keys] of Object.entries(missingMap)) {
    if (keys.length === 0) continue
    console.error(`\n  ❌ ${locale} is missing ${keys.length} key(s):`)
    for (const key of keys) {
      console.error(`       - ${key}`)
    }
  }
}

/**
 * Pretty-print a grouped list of extra keys.
 *
 * @param {Record<string, string[]>} extraMap - locale → extra keys[]
 */
function printExtras(extraMap) {
  for (const [locale, keys] of Object.entries(extraMap)) {
    if (keys.length === 0) continue
    console.error(`\n  ⚠️  ${locale} has ${keys.length} extra key(s) not in ${SOURCE_OF_TRUTH}:`)
    for (const key of keys) {
      console.error(`       - ${key}`)
    }
  }
}

function main() {
  const enKeys = flattenKeys(loadLocale(SOURCE_OF_TRUTH))
  const enKeySet = new Set(Object.keys(enKeys))
  const enCount = enKeySet.size

  console.log(`\n📋 i18n Parity Check — Source of truth: ${SOURCE_OF_TRUTH} (${enCount} keys)\n`)

  let hasErrors = false
  const missingMap = {}
  const extraMap = {}

  for (const locale of LOCALES) {
    const localeKeys = flattenKeys(loadLocale(locale))
    const localeKeySet = new Set(Object.keys(localeKeys))

    // Keys in en.json but missing from this locale
    const missing = [...enKeySet].filter((key) => !localeKeySet.has(key))
    // Keys in this locale but not in en.json
    const extra = [...localeKeySet].filter((key) => !enKeySet.has(key))

    if (missing.length > 0) {
      hasErrors = true
      missingMap[locale] = missing
    }

    if (extra.length > 0) {
      extraMap[locale] = extra
    }

    const status = missing.length === 0 ? '✅' : '❌'
    console.log(
      `  ${status} ${locale} — ${localeKeySet.size} keys` +
        (missing.length > 0 ? ` (${missing.length} missing)` : '') +
        (extra.length > 0 ? `, ${extra.length} extra` : ''),
    )
  }

  if (Object.keys(missingMap).length > 0) {
    printMissing(missingMap)
  }

  if (Object.keys(extraMap).length > 0) {
    printExtras(extraMap)
  }

  if (hasErrors) {
    console.error(
      `\n❌ Parity check FAILED — ${Object.keys(missingMap).length} locale(s) missing keys from ${SOURCE_OF_TRUTH}.`,
    )
    console.error(
      `   Add the missing keys to the affected locale files or update ${SOURCE_OF_TRUTH}.\n`,
    )
    process.exit(1)
  }

  if (Object.keys(extraMap).length > 0) {
    console.log(
      `\n⚠️  Extra keys found (not blocking). Consider adding them to ${SOURCE_OF_TRUTH} or removing them.\n`,
    )
  } else {
    console.log(`\n✅ All locale files have complete parity with ${SOURCE_OF_TRUTH}!\n`)
  }

  process.exit(0)
}

main()
