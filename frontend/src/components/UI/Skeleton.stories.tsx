import type { Meta, StoryObj } from '@storybook/react'
import { SkeletonCard, TokenCardSkeleton, TokenDetailSkeleton } from './Skeleton'

const meta: Meta = {
  title: 'UI/Skeleton',
  component: SkeletonCard,
  tags: ['autodocs'],
}
export default meta

type Story = StoryObj<typeof SkeletonCard>

export const Default: Story = {
  render: () => <SkeletonCard />,
}

export const TokenCard: Story = {
  render: () => (
    <div className="space-y-3 max-w-2xl">
      <TokenCardSkeleton />
      <TokenCardSkeleton />
      <TokenCardSkeleton />
    </div>
  ),
}

export const TokenDetail: Story = {
  render: () => <TokenDetailSkeleton />,
}
