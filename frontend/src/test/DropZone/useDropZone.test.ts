import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDropZone } from '../../components/DropZone/useDropZone'

const ACCEPTED = ['image/jpeg', 'image/png']
const MAX_MB = 5

function makeDragEvent(files: File[] = []): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    dataTransfer: { files: files as unknown as FileList },
  } as unknown as React.DragEvent
}

function makeFile(type = 'image/jpeg', sizeBytes = 100): File {
  return new File([new ArrayBuffer(sizeBytes)], 'test.jpg', { type })
}

describe('useDropZone', () => {
  it('sets isDragOver true on dragEnter and false on dragLeave', () => {
    const { result } = renderHook(() =>
      useDropZone({
        acceptedTypes: ACCEPTED,
        maxSizeMB: MAX_MB,
        onFileSelect: vi.fn(),
        onError: vi.fn(),
      }),
    )
    act(() => result.current.dragHandlers.onDragEnter(makeDragEvent()))
    expect(result.current.isDragOver).toBe(true)
    act(() => result.current.dragHandlers.onDragLeave(makeDragEvent()))
    expect(result.current.isDragOver).toBe(false)
  })

  it('dragCounter fix: stays true when entering a child then leaving it', () => {
    const { result } = renderHook(() =>
      useDropZone({
        acceptedTypes: ACCEPTED,
        maxSizeMB: MAX_MB,
        onFileSelect: vi.fn(),
        onError: vi.fn(),
      }),
    )
    // Enter parent
    act(() => result.current.dragHandlers.onDragEnter(makeDragEvent()))
    // Enter child (counter = 2)
    act(() => result.current.dragHandlers.onDragEnter(makeDragEvent()))
    // Leave child (counter = 1) — should still be dragging over
    act(() => result.current.dragHandlers.onDragLeave(makeDragEvent()))
    expect(result.current.isDragOver).toBe(true)
    // Leave parent (counter = 0)
    act(() => result.current.dragHandlers.onDragLeave(makeDragEvent()))
    expect(result.current.isDragOver).toBe(false)
  })

  it('calls onFileSelect with valid file on drop', () => {
    const onFileSelect = vi.fn()
    const { result } = renderHook(() =>
      useDropZone({ acceptedTypes: ACCEPTED, maxSizeMB: MAX_MB, onFileSelect, onError: vi.fn() }),
    )
    const file = makeFile()
    act(() => result.current.dragHandlers.onDrop(makeDragEvent([file])))
    expect(onFileSelect).toHaveBeenCalledWith(file)
  })

  it('calls onError and not onFileSelect for invalid file on drop', () => {
    const onFileSelect = vi.fn()
    const onError = vi.fn()
    const { result } = renderHook(() =>
      useDropZone({ acceptedTypes: ACCEPTED, maxSizeMB: MAX_MB, onFileSelect, onError }),
    )
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    act(() => result.current.dragHandlers.onDrop(makeDragEvent([file])))
    expect(onFileSelect).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/file type not supported/i))
  })
})
