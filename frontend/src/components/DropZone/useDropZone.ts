import { useRef, useState } from 'react'
import { validateFile } from './validateFile'

interface UseDropZoneOptions {
  acceptedTypes: string[]
  maxSizeMB: number
  onFileSelect: (file: File) => void
  onError: (message: string) => void
}

interface DragHandlers {
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

export interface UseDropZoneReturn {
  isDragOver: boolean
  dragHandlers: DragHandlers
}

export function useDropZone({
  acceptedTypes,
  maxSizeMB,
  onFileSelect,
  onError,
}: UseDropZoneOptions): UseDropZoneReturn {
  const [isDragOver, setIsDragOver] = useState(false)
  // dragCounter tracks nested drag enter/leave events from child elements.
  // Without this, dragging over a child fires dragLeave on the parent,
  // causing the drag-over state to flicker incorrectly.
  const dragCounter = useRef(0)

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current += 1
    if (dragCounter.current === 1) setIsDragOver(true)
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current -= 1
    if (dragCounter.current === 0) setIsDragOver(false)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)

    const file = e.dataTransfer.files[0]
    if (!file) return

    const result = validateFile(file, acceptedTypes, maxSizeMB)
    if (!result.valid) {
      onError(result.error ?? 'Invalid file.')
    } else {
      onFileSelect(file)
    }
  }

  return { isDragOver, dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
