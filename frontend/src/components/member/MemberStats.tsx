import React from 'react'

export interface MemberStatsData {
  totalContributions: number
  onTimeRate: number // 0–100 percentage
  groupsJoined: number
}

interface MemberStatsProps {
  stats: MemberStatsData
}

export const MemberStats: React.FC<MemberStatsProps> = ({ stats }) => (
  <dl className="grid grid-cols-3 gap-4 text-center">
    <div>
      <dt className="text-xs text-gray-500 dark:text-gray-400">Contributions</dt>
      <dd className="text-lg font-semibold text-gray-900 dark:text-white">
        {stats.totalContributions}
      </dd>
    </div>
    <div>
      <dt className="text-xs text-gray-500 dark:text-gray-400">On-time rate</dt>
      <dd className="text-lg font-semibold text-gray-900 dark:text-white">
        {stats.onTimeRate}%
      </dd>
    </div>
    <div>
      <dt className="text-xs text-gray-500 dark:text-gray-400">Groups</dt>
      <dd className="text-lg font-semibold text-gray-900 dark:text-white">
        {stats.groupsJoined}
      </dd>
    </div>
  </dl>
)
