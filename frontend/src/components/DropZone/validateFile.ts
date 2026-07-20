export interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validates a file against accepted MIME types and a max size limit.
 * Returns on the first failure — type is checked before size.
 */
export function validateFile(
  file: File,
  acceptedTypes: string[],
  maxSizeMB: number,
): ValidationResult {
  if (!acceptedTypes.includes(file.type)) {
    const readableTypes = acceptedTypes.map((t) => t.split('/')[1]?.toUpperCase() ?? t).join(', ')
    return {
      valid: false,
      error: `File type not supported. Please upload a ${readableTypes} image.`,
    }
  }

  if (file.size > maxSizeMB * 1024 * 1024) {
    return {
      valid: false,
      error: `File is too large. Maximum size is ${maxSizeMB}MB.`,
    }
  }

  return { valid: true }
}
