import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmModal } from './ConfirmModal'

const defaultProps = {
  isOpen: true,
  title: 'Confirm Transaction',
  details: [{ label: 'Amount', value: '100 XLM' }],
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

describe('ConfirmModal', () => {
  it('renders title, description and details when open', () => {
    render(<ConfirmModal {...defaultProps} description="Please review before confirming." />)
    expect(screen.getByText('Confirm Transaction')).toBeInTheDocument()
    expect(screen.getByText('Please review before confirming.')).toBeInTheDocument()
    expect(screen.getByText('Amount')).toBeInTheDocument()
    expect(screen.getByText('100 XLM')).toBeInTheDocument()
  })

  it('calls onConfirm when the confirm button is clicked (no mainnet mode)', () => {
    render(<ConfirmModal {...defaultProps} confirmLabel="Confirm Now" />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Now' }))
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when the cancel button is clicked', () => {
    render(<ConfirmModal {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    render(<ConfirmModal {...defaultProps} isOpen={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on Escape key', () => {
    const onCancel = vi.fn()
    render(<ConfirmModal {...defaultProps} onCancel={onCancel} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  describe('mainnet mode', () => {
    it('renders a mainnet warning and type-to-confirm input', () => {
      render(<ConfirmModal {...defaultProps} mainnet confirmText="TOKEN" />)
      expect(screen.getByTestId('mainnet-warning')).toBeInTheDocument()
      expect(
        screen.getByText('Type "TOKEN" to confirm on Mainnet', { exact: false }),
      ).toBeInTheDocument()
      expect(screen.getByTestId('mainnet-confirm-input')).toBeInTheDocument()
    })

    it('disables the confirm button until the user types the confirm text', () => {
      const onConfirm = vi.fn()
      render(<ConfirmModal {...defaultProps} onConfirm={onConfirm} mainnet confirmText="MINT" />)

      const confirmButton = screen.getByTestId('confirm-button')
      expect(confirmButton).toBeDisabled()

      fireEvent.change(screen.getByTestId('mainnet-confirm-input'), { target: { value: 'MINT' } })
      expect(confirmButton).toBeEnabled()

      fireEvent.click(confirmButton)
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('keeps confirm disabled when typed text does not match', () => {
      render(<ConfirmModal {...defaultProps} mainnet confirmText="MINT" />)

      const confirmButton = screen.getByTestId('confirm-button')
      fireEvent.change(screen.getByTestId('mainnet-confirm-input'), { target: { value: 'mint' } })
      expect(confirmButton).toBeDisabled()
    })

    it('resets the typed text every time the modal opens', () => {
      const onCancel = vi.fn()
      const { rerender } = render(<ConfirmModal {...defaultProps} onCancel={onCancel} mainnet confirmText="TOKEN" />)

      const input = screen.getByTestId('mainnet-confirm-input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'TOKEN' } })
      expect(input.value).toBe('TOKEN')

      // close and reopen
      rerender(<ConfirmModal {...defaultProps} onCancel={onCancel} mainnet confirmText="TOKEN" isOpen={false} />)
      rerender(<ConfirmModal {...defaultProps} onCancel={onCancel} mainnet confirmText="TOKEN" isOpen />)
      expect((screen.getByTestId('mainnet-confirm-input') as HTMLInputElement).value).toBe('')
    })

    it('supports a custom confirm label', () => {
      render(<ConfirmModal {...defaultProps} mainnet confirmLabel="Deploy to Mainnet" />)
      expect(screen.getByRole('button', { name: 'Deploy to Mainnet' })).toBeInTheDocument()
    })
  })
})

describe('ConfirmModal integration guard', () => {
  it('does not require the type-to-confirm when mainnet is explicitly false', () => {
    const onConfirm = vi.fn()
    render(<ConfirmModal {...defaultProps} onConfirm={onConfirm} mainnet={false} confirmText="MAINNET" />)
    const confirmButton = screen.getByTestId('confirm-button')
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})