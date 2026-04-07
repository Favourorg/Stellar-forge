import React, { useState, useEffect } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { Spinner } from '../../../components/UI/Spinner'
import { GroupSettings } from '../../../components/settings/GroupSettings'
import type { GroupConfig } from '../../../components/settings/GroupSettings'
import type { GroupMember, MemberRole } from '../../../components/settings/MemberManagement'
import type { NotificationPreferences } from '../../../components/settings/NotificationSettings'

interface GroupSettingsData {
  config: GroupConfig
  members: GroupMember[]
  notificationPrefs: NotificationPreferences
}

export default function GroupSettingsPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<GroupSettingsData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    fetch(`/api/groups/${id}/settings`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load group settings')
        return res.json() as Promise<GroupSettingsData>
      })
      .then((d) => { if (!cancelled) setData(d) })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error')
      })
      .finally(() => { if (!cancelled) setIsLoading(false) })

    return () => { cancelled = true }
  }, [id])

  if (!id) return <Navigate to="/" replace />
  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>
  if (error) return <p className="text-red-600 dark:text-red-400 text-center py-12">{error}</p>
  if (!data) return null

  const handleRemoveMember = (memberId: string) => {
    setData((prev) =>
      prev ? { ...prev, members: prev.members.filter((m) => m.id !== memberId) } : prev,
    )
  }

  const handleChangeRole = (memberId: string, role: MemberRole) => {
    setData((prev) =>
      prev
        ? { ...prev, members: prev.members.map((m) => (m.id === memberId ? { ...m, role } : m)) }
        : prev,
    )
  }

  const handleSaveNotifications = (prefs: NotificationPreferences) => {
    fetch(`/api/groups/${id}/notifications`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    }).catch(() => {/* handled by UI feedback elsewhere */})
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <GroupSettings
        groupId={id}
        config={data.config}
        members={data.members}
        notificationPrefs={data.notificationPrefs}
        onRemoveMember={handleRemoveMember}
        onChangeRole={handleChangeRole}
        onSaveNotifications={handleSaveNotifications}
      />
    </div>
  )
}
