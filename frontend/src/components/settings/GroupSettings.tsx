import React, { useState } from 'react'
import { Card } from '../UI/Card'
import { MemberManagement, type GroupMember, type MemberRole } from './MemberManagement'
import { NotificationSettings, type NotificationPreferences } from './NotificationSettings'

export interface GroupConfig {
  name: string
  description?: string
}

interface GroupSettingsProps {
  groupId: string
  config: GroupConfig
  members: GroupMember[]
  notificationPrefs?: NotificationPreferences
  onRemoveMember: (memberId: string) => void
  onChangeRole: (memberId: string, role: MemberRole) => void
  onSaveNotifications: (prefs: NotificationPreferences) => void
}

type Tab = 'general' | 'members' | 'notifications'

export const GroupSettings: React.FC<GroupSettingsProps> = ({
  groupId,
  config,
  members,
  notificationPrefs,
  onRemoveMember,
  onChangeRole,
  onSaveNotifications,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('general')

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'members', label: 'Members' },
    { id: 'notifications', label: 'Notifications' },
  ]

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Group Settings</h1>

      {/* Tab bar */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-6" aria-label="Settings sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors focus:outline-none ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
              aria-current={activeTab === tab.id ? 'page' : undefined}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab panels */}
      {activeTab === 'general' && (
        <Card title="General">
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Group ID</dt>
              <dd className="font-mono text-gray-900 dark:text-white">{groupId}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Name</dt>
              <dd className="text-gray-900 dark:text-white">{config.name}</dd>
            </div>
            {config.description && (
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Description</dt>
                <dd className="text-gray-900 dark:text-white">{config.description}</dd>
              </div>
            )}
          </dl>
        </Card>
      )}

      {activeTab === 'members' && (
        <Card title={`Members (${members.length})`}>
          <MemberManagement
            members={members}
            onRemove={onRemoveMember}
            onChangeRole={onChangeRole}
          />
        </Card>
      )}

      {activeTab === 'notifications' && (
        <Card title="Notifications">
          <NotificationSettings initial={notificationPrefs} onSave={onSaveNotifications} />
        </Card>
      )}
    </div>
  )
}
