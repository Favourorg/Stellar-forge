import { useRef, useState, useCallback } from 'react'
import { useDropZone } from './useDropZone'
import { validateFile } from './validateFile'

export interface DropZoneProps {
  onFileSelect: (file: File) => void
  acceptedTypes?: string[]
  maxSizeMB?: number
  className?: string
}

const DEFAULT_TYPES = ['image/jpeg', 'image/png', 'image/gif']
const DEFAULT_MAX_MB = 5

export const DropZone: React.FC<DropZoneProps> = ({
  onFileSelect,
  acceptedTypes = DEFAULT_TYPES,
  maxSizeMB = DEFAULT_MAX_MB,
  className = '',
}) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleError = useCallback(
    (message: string) => {
      setError(message)
      setPreview(null)
      // Return focus to the zone so screen readers announce the error
      zoneRef.current?.focus()
    },
    [],
  )

  const handleFileSelect = useCallback(
    (file: File) => {
      setError(null)
      setPreview(URL.createObjectURL(file))
      onFileSelect(file)
    },
    [onFileSelect],
  )

  const { isDragOver, dragHandlers } = useDropZone({
    acceptedTypes,
    maxSizeMB,
    onFileSelect: handleFileSelect,
    onError: handleError,
  })

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const result = validateFile(file, acceptedTypes, maxSizeMB)
    if (!result.valid) {
      handleError(result.error ?? 'Invalid file.')
    } else {
      handleFileSelect(file)
    }
    // Reset so the same file can be re-selected after removal
    e.target.value = ''
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      inputRef.current?.click()
    }
  }

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation()
    setPreview(null)
    setError(null)
  }

  // ── Visual state classes ──────────────────────────────────────────────────

  let zoneClasses = 'relative flex flex-col items-center justify-center rounded-lg p-6 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 '

  if (preview) {
    zoneClasses += 'border-2 border-solid border-green-400 bg-green-50'
  } else if (error) {
    zoneClasses += 'border-2 border-solid border-red-400 bg-red-50'
  } else if (isDragOver) {
    zoneClasses += 'border-2 border-solid border-blue-500 bg-blue-50'
  } else {
    zoneClasses += 'border-2 border-dashed border-zinc-300 bg-zinc-50 hover:bg-zinc-100'
  }

  return (
    <div className={className}>
      {/* Hidden file input — not focusable, the div is the accessible element */}
      <input
        ref={inputRef}
        type="file"
        accept={acceptedTypes.join(',')}
        onChange={handleInputChange}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
      />

      <div
        ref={zoneRef}
        role="button"
        tabIndex={0}
        aria-label="Upload image"
        className={zoneClasses}
        onClick={() => inputRef.current?.click()}
        onKeyDown={handleKeyDown}
        {...dragHandlers}
      >
        {preview ? (
          // ── Preview state ───────────────────────────────────────────────
          <>
            <img
              src={preview}
              alt="Selected file preview"
              className="max-h-48 max-w-full rounded object-contain"
            />
            <button
              type="button"
              onClick={handleRemove}
              className="mt-3 text-sm text-red-600 hover:text-red-800 underline"
              aria-label="Remove selected image"
            >
              Remove
            </button>
          </>
        ) : (
          // ── Idle / drag-over / error state ──────────────────────────────
          <>
            {/* Upload icon */}
            <svg
              aria-hidden="true"
              className={`mb-3 h-10 w-10 ${isDragOver ? 'text-blue-500' : 'text-zinc-400'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
              />
            </svg>

            <p className="text-sm font-medium text-zinc-700">
              {isDragOver ? 'Drop your image here' : 'Drag and drop or click to browse'}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {acceptedTypes.map((t) => t.split('/')[1]?.toUpperCase()).join(', ')} — max {maxSizeMB}MB
            </p>
          </>
        )}
      </div>

      {/* Error message rendered outside the zone div so it's always visible */}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
