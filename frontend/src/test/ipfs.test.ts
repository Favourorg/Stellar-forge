import { describe, it, expect } from 'vitest'
import { validateTokenMetadata, IPFSUploadError } from '../services/ipfs'

// ── Helpers ───────────────────────────────────────────────────────────────────

function validMetadata(): Record<string, unknown> {
  return {
    name: 'My Token',
    description: 'A great token for testing',
    image: 'ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
  }
}

// ── Valid metadata ────────────────────────────────────────────────────────────

describe('validateTokenMetadata — valid cases', () => {
  it('accepts well-formed metadata', () => {
    const result = validateTokenMetadata(validMetadata())
    expect(result.name).toBe('My Token')
    expect(result.description).toBe('A great token for testing')
    expect(result.image).toBe('ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco')
  })

  it('accepts metadata with a valid CIDv1 image URI', () => {
    const meta = {
      ...validMetadata(),
      image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    }
    const result = validateTokenMetadata(meta)
    expect(result.image).toBe(meta.image)
  })
})

// ── Name validation ───────────────────────────────────────────────────────────

describe('validateTokenMetadata — name', () => {
  it('rejects missing name', () => {
    const { name, ...meta } = validMetadata()
    expect(() => validateTokenMetadata(meta)).toThrow(IPFSUploadError)
    expect(() => validateTokenMetadata(meta)).toThrow(/name.*missing/i)
  })

  it('rejects null name', () => {
    const fn = () => validateTokenMetadata({ ...validMetadata(), name: null })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/name.*missing/i)
  })

  it('rejects empty string name', () => {
    const fn = () => validateTokenMetadata({ ...validMetadata(), name: '' })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/name.*empty/i)
  })

  it('rejects whitespace-only name', () => {
    const fn = () => validateTokenMetadata({ ...validMetadata(), name: '   ' })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/name.*empty/i)
  })

  it('rejects name exceeding 32 characters', () => {
    const longName = 'A'.repeat(33)
    const fn = () => validateTokenMetadata({ ...validMetadata(), name: longName })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/exceed/)
  })

  it('accepts name at exactly 32 characters', () => {
    const exactName = 'A'.repeat(32)
    const result = validateTokenMetadata({ ...validMetadata(), name: exactName })
    expect(result.name).toBe(exactName)
  })
})

// ── Description validation ────────────────────────────────────────────────────

describe('validateTokenMetadata — description', () => {
  it('rejects missing description', () => {
    const { description, ...meta } = validMetadata()
    const fn = () => validateTokenMetadata(meta)
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/description.*missing/i)
  })

  it('rejects null description', () => {
    const fn = () => validateTokenMetadata({ ...validMetadata(), description: null })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/description.*missing/i)
  })

  it('rejects empty string description', () => {
    const fn = () => validateTokenMetadata({ ...validMetadata(), description: '' })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/description.*empty/i)
  })

  it('rejects whitespace-only description', () => {
    const fn = () => validateTokenMetadata({ ...validMetadata(), description: '   ' })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/description.*empty/i)
  })

  it('rejects description exceeding 500 characters', () => {
    const longDesc = 'A'.repeat(501)
    const fn = () => validateTokenMetadata({ ...validMetadata(), description: longDesc })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/exceed/)
  })

  it('accepts description at exactly 500 characters', () => {
    const exactDesc = 'A'.repeat(500)
    const result = validateTokenMetadata({ ...validMetadata(), description: exactDesc })
    expect(result.description).toBe(exactDesc)
  })
})

// ── Image validation ──────────────────────────────────────────────────────────

describe('validateTokenMetadata — image', () => {
  it('rejects missing image', () => {
    const { image, ...meta } = validMetadata()
    const fn = () => validateTokenMetadata(meta)
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/image.*missing/i)
  })

  it('rejects null image', () => {
    const fn = () => validateTokenMetadata({ ...validMetadata(), image: null })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/image.*missing/i)
  })

  it('rejects empty string image', () => {
    const fn = () => validateTokenMetadata({ ...validMetadata(), image: '' })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/image.*empty/i)
  })

  it('rejects non-IPFS URI image (http URL)', () => {
    const fn = () =>
      validateTokenMetadata({ ...validMetadata(), image: 'https://example.com/image.png' })
    expect(fn).toThrow(IPFSUploadError)
    expect(fn).toThrow(/IPFS/i)
  })

  it('rejects plain CID without ipfs:// prefix', () => {
    const fn = () =>
      validateTokenMetadata({ ...validMetadata(), image: 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco' })
    expect(fn).toThrow(IPFSUploadError)
  })

  it('rejects nonsense string as image', () => {
    const fn = () =>
      validateTokenMetadata({ ...validMetadata(), image: 'not-a-uri' })
    expect(fn).toThrow(IPFSUploadError)
  })

  it('accepts a valid CIDv0 IPFS URI', () => {
    const meta = {
      ...validMetadata(),
      image: 'ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
    }
    const result = validateTokenMetadata(meta)
    expect(result.image).toBe(meta.image)
  })

  it('accepts a valid CIDv1 IPFS URI', () => {
    const meta = {
      ...validMetadata(),
      image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    }
    const result = validateTokenMetadata(meta)
    expect(result.image).toBe(meta.image)
  })
})
