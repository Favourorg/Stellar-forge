import React from 'react'
import { Card } from '../UI/Card'
import { Spinner } from '../UI/Spinner'
import { QuickActions, type QuickAction } from './QuickActions'
import { useWalletBalance } from '../../hooks/useWalletBalance'

interface BalanceWidgetProps {
  actions?: QuickAction[]
}

export const BalanceWidget: React.FC<BalanceWidgetProps> = ({ actions = [] }) => {
  const { balance, pendingTransactions, isLoading, error } = useWalletBalance()

  return (
    <Card title="Wallet Balance">
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-3xl font-bold text-gray-900 dark:text-white">
              {balance ?? '—'} <span className="text-base font-normal text-gray-500">XLM</span>
            </p>
            {pendingTransactions.length > 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {pendingTransactions.length} pending transaction
                {pendingTransactions.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>

          {pendingTransactions.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">
              {pendingTransactions.map((tx) => (
                <li key={tx.id} className="flex justify-between py-1">
                  <span className="text-gray-600 dark:text-gray-300">{tx.description}</span>
                  <span className="font-mono text-gray-900 dark:text-white">{tx.amount}</span>
                </li>
              ))}
            </ul>
          )}

          {actions.length > 0 && <QuickActions actions={actions} />}
        </div>
      )}
    </Card>
  )
}
