import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DropZone } from '../../components/DropZone/DropZone'

// jsdom doesn't implement URL.createObjectURL
beforeEach(() => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:mock') })
})

function makeFile(name = 'photo.jpg', type = 'image/jpeg', sizeBytes = 100): File {
  return new File([new ArrayBuffer(sizeBytes)], name, { type })
}

describe('DropZone', () => {
  it('renders idle state with upload text', () => {
    render(<DropZone onFileSelect={vi.fn()} />)
    expect(screen.getByText(/drag and drop or click to browse/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /upload image/i })).toBeTruthy()
  })

  it('calls onFileSelect and shows preview on valid file drop', () => {
    const onFileSelect = vi.fn()
    render(<DropZone onFileSelect={onFileSelect} />)
    const zone = screen.getByRole('button', { name: /upload image/i })
    const file = makeFile()
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onFileSelect).toHaveBeenCalledWith(file)
    expect(screen.getByAltText(/preview/i)).toBeTruthy()
  })

  it('shows error and does not call onFileSelect for invalid file type', () => {
    const onFileSelect = vi.fn()
    render(<DropZone onFileSelect={onFileSelect} />)
    const zone = screen.getByRole('button', { name: /upload image/i })
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onFileSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/file type not supported/i)).toBeTruthy()
  })

  it('shows error for oversized file', () => {
    const onFileSelect = vi.fn()
    render(<DropZone onFileSelect={onFileSelect} maxSizeMB={1} />)
    const zone = screen.getByRole('button', { name: /upload image/i })
    const file = makeFile('big.jpg', 'image/jpeg', 2 * 1024 * 1024)
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onFileSelect).not.toHaveBeenCalled()
    expect(screen.getByText(/too large/i)).toBeTruthy()
  })

  it('Enter key triggers file input click', () => {
    render(<DropZone onFileSelect={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /upload image/i })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    fireEvent.keyDown(zone, { key: 'Enter' })
    expect(clickSpy).toHaveBeenCalled()
  })

  it('Space key triggers file input click', () => {
    render(<DropZone onFileSelect={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /upload image/i })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    fireEvent.keyDown(zone, { key: ' ' })
    expect(clickSpy).toHaveBeenCalled()
  })

  it('remove button resets zone back to idle', () => {
    const onFileSelect = vi.fn()
    render(<DropZone onFileSelect={onFileSelect} />)
    const zone = screen.getByRole('button', { name: /upload image/i })
    fireEvent.drop(zone, { dataTransfer: { files: [makeFile()] } })
    expect(screen.getByAltText(/preview/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(screen.queryByAltText(/preview/i)).toBeNull()
    expect(screen.getByText(/drag and drop or click to browse/i)).toBeTruthy()
  })

  it('shows drag-over text when dragging over the zone', () => {
    render(<DropZone onFileSelect={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /upload image/i })
    fireEvent.dragEnter(zone)
    expect(screen.getByText(/drop your image here/i)).toBeTruthy()
  })
})
