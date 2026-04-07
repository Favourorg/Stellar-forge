import React from 'react'
import { Card } from '../UI/Card'
import { MemberStats, type MemberStatsData } from './MemberStats'
import { ContributionHistory, type Contribution } from './ContributionHistory'

export interface MemberData {
  id: string
  address: string
  name: string
  avatarUrl?: string
  reliabilityScore: number // 0–100
  achievements: string[]
  groupMemberships: string[]
  stats: MemberStatsData
  contributions: Contribution[]
}

interface MemberCardProps {
  member: MemberData
}

export const MemberCard: React.FC<MemberCardProps> = ({ member }) => (
  <div className="max-w-2xl mx-auto space-y-6">
    {/* Profile header */}
    <Card>
      <div className="flex items-center gap-4">
        {member.avatarUrl ? (
          <img
            src={member.avatarUrl}
            alt={member.name}
            className="w-16 h-16 rounded-full object-cover"
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center text-2xl font-bold text-blue-600 dark:text-blue-300">
            {member.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">{member.name}</h1>
          <p className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">
            {member.address}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            Reliability score:{' '}
            <span className="font-semibold text-gray-900 dark:text-white">
              {member.reliabilityScore}/100
            </span>
          </p>
        </div>
      </div>

      {member.achievements.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {member.achievements.map((a) => (
            <span
              key={a}
              className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
            >
              {a}
            </span>
          ))}
        </div>
      )}

      {member.groupMemberships.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Groups</p>
          <div className="flex flex-wrap gap-2">
            {member.groupMemberships.map((g) => (
              <span
                key={g}
                className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
              >
                {g}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>

    <Card title="Stats">
      <MemberStats stats={member.stats} />
    </Card>

    <Card title="Contribution History">
      <ContributionHistory contributions={member.contributions} />
    </Card>
  </div>
)
