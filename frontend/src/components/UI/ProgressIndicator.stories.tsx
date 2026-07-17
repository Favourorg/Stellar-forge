import type { Meta, StoryObj } from '@storybook/react'
import { ProgressIndicator } from './ProgressIndicator'

const meta: Meta<typeof ProgressIndicator> = {
  title: 'UI/ProgressIndicator',
  component: ProgressIndicator,
  tags: ['autodocs'],
}
export default meta

type Story = StoryObj<typeof ProgressIndicator>

export const Default: Story = {
  args: {
    steps: [
      { label: 'Validate token details', status: 'pending' },
      { label: 'Submit transaction', status: 'pending' },
      { label: 'Confirm on network', status: 'pending' },
    ],
  },
}

export const InProgress: Story = {
  args: {
    steps: [
      { label: 'Validate token details', status: 'completed' },
      { label: 'Submit transaction', status: 'in-progress' },
      { label: 'Confirm on network', status: 'pending' },
    ],
  },
}

export const Completed: Story = {
  args: {
    steps: [
      { label: 'Validate token details', status: 'completed' },
      { label: 'Submit transaction', status: 'completed' },
      { label: 'Confirm on network', status: 'completed' },
    ],
  },
}

export const WithError: Story = {
  args: {
    steps: [
      { label: 'Validate token details', status: 'completed' },
      { label: 'Submit transaction', status: 'error' },
      { label: 'Confirm on network', status: 'pending' },
    ],
  },
}
