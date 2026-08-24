import type { Meta, StoryObj } from '@storybook/react'
import { fn } from 'storybook/test'
import { ConfirmModal } from './ConfirmModal'

const meta: Meta<typeof ConfirmModal> = {
  title: 'UI/ConfirmModal',
  component: ConfirmModal,
  tags: ['autodocs'],
  args: {
    isOpen: true,
    title: 'Confirm Transaction',
    details: [
      { label: 'Amount', value: '100 XLM' },
      { label: 'Recipient', value: 'GABCD…WXYZ' },
      { label: 'Network Fee', value: '0.00001 XLM' },
    ],
    onConfirm: fn(),
    onCancel: fn(),
  },
  parameters: { layout: 'fullscreen' },
}
export default meta

type Story = StoryObj<typeof ConfirmModal>

export const Default: Story = {
  args: {
    description: 'Please review the details before confirming.',
  },
}

export const WithoutDescription: Story = {}

export const DestructiveAction: Story = {
  args: {
    title: 'Delete Token',
    description: 'This action cannot be undone.',
    confirmLabel: 'Delete',
    details: [{ label: 'Token', value: 'MTK — My Token' }],
  },
}

export const MainnetMode: Story = {
  args: {
    title: 'Confirm Mainnet Deployment',
    description: 'This action will cost real XLM on Mainnet.',
    mainnet: true,
    confirmText: 'MAINNET',
    details: [
      { label: 'Token Name', value: 'My Token' },
      { label: 'Token Symbol', value: 'MTK' },
      { label: 'Initial Supply', value: '1,000,000' },
    ],
  },
}

export const MainnetModeCustomText: Story = {
  args: {
    title: 'Confirm Mainnet Mint',
    mainnet: true,
    confirmText: 'MINT',
    details: [
      { label: 'Token', value: 'My Token (MTK)' },
      { label: 'Amount', value: '500' },
    ],
  },
}

export const Closed: Story = { args: { isOpen: false } }