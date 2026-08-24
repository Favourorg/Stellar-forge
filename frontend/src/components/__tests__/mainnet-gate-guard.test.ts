import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Guard: no mutating form may reintroduce the mainnet-confirmation dead-code gap.
 *
 * Every write-path component that submits a Soroban transaction on mainnet must
 * gate the transaction behind a mainnet-specific confirmation step. The accepted
 * pattern is passing `mainnet={network === 'mainnet'}` to a `<ConfirmModal>`.
 *
 * This test is intentionally source-scanning (not behavior-based) so a brand-new
 * form that copies an old (ungated) pattern fails CI immediately. It is the
 * "new form can't silently reintroduce the gap" acceptance criterion from
 * issue #1157.
 */
describe('mainnet confirmation gate guard (issue #1157)', () => {
  const componentsDir = path.join(process.cwd(), 'src/components')

  const mutatingForms = [
    'TokenForm.tsx',
    'MintForm.tsx',
    'BurnForm.tsx',
    'SetMetadataForm.tsx',
    'AdminPanel.tsx',
  ]

  // Components that are not themselves submit forms but render on the dashboard.
  // Do NOT add write-path forms here.
  const whitelistedNonForms = [
    'CreateToken.tsx', // page container — delegates submit to TokenForm
  ]

  describe.each(mutatingForms)(`%s`, (file) => {
    it('passes the mainnet gate to its ConfirmModal', () => {
      const source = fs.readFileSync(path.join(componentsDir, file), 'utf8')

      // Every mutating form must render a ConfirmModal…
      expect(source, `${file} must render a <ConfirmModal>`).toMatch(/<ConfirmModal/)

      // …and gate it on the current network so mainnet actions require
      // type-to-confirm friction before the tx is built.
      expect(
        source,
        `${file} must pass mainnet={network === 'mainnet'} to its ConfirmModal`,
      ).toMatch(/mainnet=\{network === 'mainnet'\}/)
    })
  })

  describe('new write-path component scan', () => {
    it('finds no mutating submit component that renders an un-gated ConfirmModal', () => {
      const isSourceFile = (f: string) => f.endsWith('.tsx') && !f.startsWith('__') && !f.endsWith('.test.tsx') && !f.endsWith('.stories.tsx')
      const files = fs
        .readdirSync(componentsDir)
        .filter(isSourceFile)
        .filter((f) => !whitelistedNonForms.includes(f))

      // Also scan the UI subdirectory
      const uiDir = path.join(componentsDir, 'UI')
      const uiFiles = fs.readdirSync(uiDir).filter(isSourceFile)

      const allFiles = [...files, ...uiFiles.map((f) => path.join('UI', f))]

      const unguarded: string[] = []

      for (const file of allFiles) {
        const source = fs.readFileSync(path.join(componentsDir, file), 'utf8')
        // A component that renders ConfirmModal and has a submit/confirm
        // handler must gate it on mainnet.
        if (
          source.includes('<ConfirmModal') &&
          /(handleSubmit|onSubmit|confirm|deploy|mint|burn|updateFees|toggle)/i.test(source) &&
          !source.includes('mainnet={network === \'mainnet\'}')
        ) {
          unguarded.push(file)
        }
      }

      // Only ConfirmModal.tsx itself (the gate implementation) may be exempt.
      expect(
        unguarded.includes('UI/ConfirmModal.tsx'),
        `Unexpected un-gated form(s) found: ${unguarded.join(', ')}`,
      ).toBe(true)
      expect(unguarded.filter((f) => f !== 'UI/ConfirmModal.tsx')).toEqual([])
    })
  })
})