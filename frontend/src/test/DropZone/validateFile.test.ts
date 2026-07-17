import { describe, it, expect } from 'vitest'
import { validateFile } from '../../components/DropZone/validateFile'

const ACCEPTED = ['image/jpeg', 'image/png', 'image/gif']
const MAX_MB = 5

function makeFile(name: string, type: string, sizeBytes: number): File {
  return new File([new ArrayBuffer(sizeBytes)], name, { type })
}

describe('validateFile', () => {
  it('returns valid for an accepted type within size limit', () => {
    const file = makeFile('photo.jpg', 'image/jpeg', 1 * 1024 * 1024)
    expect(validateFile(file, ACCEPTED, MAX_MB)).toEqual({ valid: true })
  })

  it('returns error for unsupported file type', () => {
    const file = makeFile('doc.pdf', 'application/pdf', 100)
    const result = validateFile(file, ACCEPTED, MAX_MB)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/file type not supported/i)
    expect(result.error).toMatch(/JPEG|PNG|GIF/i)
  })

  it('returns error for oversized file', () => {
    const file = makeFile('big.png', 'image/png', 6 * 1024 * 1024)
    const result = validateFile(file, ACCEPTED, MAX_MB)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/too large/i)
    expect(result.error).toMatch(/5MB/i)
  })

  it('checks type before size — returns type error when both fail', () => {
    const file = makeFile('big.pdf', 'application/pdf', 10 * 1024 * 1024)
    const result = validateFile(file, ACCEPTED, MAX_MB)
    expect(result.error).toMatch(/file type not supported/i)
  })
})
