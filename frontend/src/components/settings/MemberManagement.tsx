import React from 'react'
import { Button } from '../UI/Button'

export type MemberRole = 'admin' | 'member'

export interface GroupMember {
  id: string
  address: string
  name?: string
  role: MemberRole
}

interface MemberManagementProps {
  members: GroupMember[]
  onRemove: (memberId: string) => void
  onChangeRole: (memberId: string, role: MemberRole) => void
}

export const MemberManagement: React.FC<MemberManagementProps> = ({
  members,
  onRemove,
  onChangeRole,
}) => {
  return (
    <ul className="divide-y divide-gray-200 dark:divide-gray-700">
      {members.map((member) => (
        <li key={member.id} className="flex items-center justify-between py-3 gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
              {member.name ?? member.address}
            </p>
            {member.name && (
              <p className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                {member.address}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              value={member.role}
              onChange={(e) => onChangeRole(member.id, e.target.value as MemberRole)}
              className="text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label={`Role for ${member.name ?? member.address}`}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRemove(member.id)}
              aria-label={`Remove ${member.name ?? member.address}`}
            >
              Remove
            </Button>
          </div>
        </li>
      ))}
      {members.length === 0 && (
        <li className="py-4 text-sm text-gray-500 dark:text-gray-400 text-center">
          No members found.
        </li>
      )}
    </ul>
  )
}
