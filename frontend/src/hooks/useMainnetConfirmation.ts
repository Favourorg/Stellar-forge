import { useState, useCallback } from 'react'
import { isMainnet } from '../utils/network'

interface MainnetConfirmDetails {
  label: string
  value: string | number
}

interface UseMainnetConfirmationReturn {
  showModal: boolean
  details: MainnetConfirmDetails[]
  requestConfirmation: (details: MainnetConfirmDetails[], onConfirm: () => void) => void
  closeModal: () => void
  confirmAction: () => void
  /** Whether the app is currently connected to mainnet */
  isMainnetNetwork: boolean
}

/**
 * Generic mainnet confirmation gate.
 *
 * Checks `isMainnet()` and either shows the confirmation modal (mainnet) or
 * calls `onConfirm` directly (testnet). This is a programmatic alternative to
 * passing `mainnet={isMainnet()}` to `<ConfirmModal>` — use whichever fits
 * your component's architecture.
 *
 * @deprecated Prefer `<ConfirmModal mainnet={isMainnet()} confirmText="..." />`
 *   for components that already render a ConfirmModal. This hook exists for
 *   cases where the confirmation gate must be handled programmatically (e.g.
 *   when the form doesn't use ConfirmModal directly).
 */
export const useMainnetConfirmation = (): UseMainnetConfirmationReturn => {
  const [showModal, setShowModal] = useState(false)
  const [details, setDetails] = useState<MainnetConfirmDetails[]>([])
  const [onConfirmCallback, setOnConfirmCallback] = useState<(() => void) | null>(null)

  const requestConfirmation = useCallback((confirmDetails: MainnetConfirmDetails[], onConfirm: () => void) => {
    if (isMainnet()) {
      setDetails(confirmDetails)
      setOnConfirmCallback(() => onConfirm)
      setShowModal(true)
    } else {
      // On testnet, skip the confirmation modal
      onConfirm()
    }
  }, [])

  const closeModal = useCallback(() => {
    setShowModal(false)
    setDetails([])
    setOnConfirmCallback(null)
  }, [])

  const confirmAction = useCallback(() => {
    if (onConfirmCallback) {
      onConfirmCallback()
    }
    closeModal()
  }, [onConfirmCallback, closeModal])

  return {
    showModal,
    details,
    requestConfirmation,
    closeModal,
    confirmAction,
    isMainnetNetwork: isMainnet(),
  }
}