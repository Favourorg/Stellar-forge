import React, { useState } from 'react'
import { Button } from '../UI/Button'

export interface NotificationPreferences {
  contributions: boolean
  payouts: boolean
  newMembers: boolean
}

interface NotificationSettingsProps {
  initial?: NotificationPreferences
  onSave: (prefs: NotificationPreferences) => void
}

const DEFAULT_PREFS: NotificationPreferences = {
  contributions: true,
  payouts: true,
  newMembers: false,
}

const LABELS: Record<keyof NotificationPreferences, string> = {
  contributions: 'Contribution alerts',
  payouts: 'Payout notifications',
  newMembers: 'New member joins',
}

export const NotificationSettings: React.FC<NotificationSettingsProps> = ({
  initial = DEFAULT_PREFS,
  onSave,
}) => {
  const [prefs, setPrefs] = useState<NotificationPreferences>(initial)

  const toggle = (key: keyof NotificationPreferences) =>
    setPrefs((prev) => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {(Object.keys(LABELS) as (keyof NotificationPreferences)[]).map((key) => (
          <li key={key} className="flex items-center justify-between">
            <span className="text-sm text-gray-700 dark:text-gray-300">{LABELS[key]}</span>
            <button
              role="switch"
              aria-checked={prefs[key]}
              onClick={() => toggle(key)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                prefs[key] ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  prefs[key] ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </li>
        ))}
      </ul>
      <Button onClick={() => onSave(prefs)}>Save preferences</Button>
    </div>
  )
}
