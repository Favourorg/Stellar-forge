import React from 'react'
import { formatTimestamp } from '../../utils/formatting'

export interface Contribution {
  id: string
  amount: string
  date: number // unix seconds
  groupName: string
}

interface ContributionHistoryProps {
  contributions: Contribution[]
}

export const ContributionHistory: React.FC<ContributionHistoryProps> = ({ contributions }) => {
  if (contributions.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
        No contributions yet.
      </p>
    )
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
          <th className="pb-2 font-medium">Group</th>
          <th className="pb-2 font-medium">Amount</th>
          <th className="pb-2 font-medium">Date</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
        {contributions.map((c) => (
          <tr key={c.id}>
            <td className="py-2 text-gray-900 dark:text-white">{c.groupName}</td>
            <td className="py-2 font-mono text-gray-900 dark:text-white">{c.amount}</td>
            <td className="py-2 text-gray-500 dark:text-gray-400">{formatTimestamp(c.date)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
