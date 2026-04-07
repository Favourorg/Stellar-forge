import React from 'react'
import { Button } from '../UI/Button'

export interface QuickAction {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'outline'
}

interface QuickActionsProps {
  actions: QuickAction[]
}

export const QuickActions: React.FC<QuickActionsProps> = ({ actions }) => (
  <div className="flex flex-wrap gap-2">
    {actions.map((action) => (
      <Button
        key={action.label}
        variant={action.variant ?? 'outline'}
        size="sm"
        onClick={action.onClick}
      >
        {action.label}
      </Button>
    ))}
  </div>
)
