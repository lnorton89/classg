import { createFileRoute, Link } from '@tanstack/react-router'
import { BellIcon, FilterIcon, Volume2Icon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { Segmented } from '@/components/ui/segmented'
import { Alert } from '@/components/ui/misc'
import type { LogLevel } from '@/features/logs/log-store'
import {
  isCategoryEnabled,
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_HINT,
  NOTIFY_CATEGORY_LABEL,
  type NotifyCategory,
} from '@/features/notifications/feed'
import { SettingRow, SettingsCard, ToggleRow } from '@/features/settings/controls'

export const Route = createFileRoute('/settings/notifications')({
  component: NotificationSettings,
})

function NotificationSettings() {
  const { preferences, setPreference } = usePreferences()
  const categories = preferences.notifyCategories

  const setCategory = (category: NotifyCategory, enabled: boolean) => {
    setPreference('notifyCategories', { ...categories, [category]: enabled })
  }

  const droneOff = !isCategoryEnabled(categories, 'drone')

  return (
    <>
      <SettingsCard
        icon={BellIcon}
        title="What appears in the drawer"
        description="The bell in the header collects recent drone activity alongside what this console saw happen. Switching a category off hides it from the drawer and from the unread count — it never stops the receiver recording it."
      >
        {droneOff ? (
          <Alert tone="warn" title="Drone detections are hidden">
            The drawer will not list tracks while this is off. Detection and recording carry on
            regardless — you are only choosing not to be shown them here.
          </Alert>
        ) : null}

        {NOTIFY_CATEGORIES.map((category) => (
          <ToggleRow
            key={category}
            label={NOTIFY_CATEGORY_LABEL[category]}
            hint={NOTIFY_CATEGORY_HINT[category]}
            checked={isCategoryEnabled(categories, category)}
            onCheckedChange={(checked) => setCategory(category, checked)}
          />
        ))}
      </SettingsCard>

      <SettingsCard
        icon={FilterIcon}
        title="Severity"
        description="Applies to system events only. Drone detections are all recorded at info, so a higher floor here would switch off the detections themselves rather than quieten them."
      >
        <SettingRow
          label="Minimum severity for system events"
          hint={
            <>
              Debug entries arrive in rate-limited bursts and are meant for the{' '}
              <Link to="/logs" className="text-primary underline-offset-2 hover:underline">
                event log
              </Link>
              , not for notifications.
            </>
          }
        >
          <Segmented
            aria-label="Minimum severity for system events"
            value={preferences.notifyMinLevel}
            onValueChange={(value: LogLevel) => setPreference('notifyMinLevel', value)}
            options={[
              { value: 'debug', label: 'Everything' },
              { value: 'info', label: 'Info and above' },
              { value: 'warn', label: 'Warnings' },
              { value: 'error', label: 'Errors only' },
            ]}
            className="w-full"
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        icon={Volume2Icon}
        title="Sound"
        description="The realistic way this console is used is not being stared at. A sound is what makes a continuously recording detector worth leaving on a bench."
      >
        <SettingRow
          label="Audible alert on new track"
          hint="A short two-tone chirp, and only ever on a track's first appearance — re-firing while a drone loiters would train you to ignore it. Browsers only permit sound after you have interacted with the page at least once."
        >
          <Segmented
            aria-label="Audible alert on new track"
            value={preferences.alertLevel}
            onValueChange={(value) => setPreference('alertLevel', value)}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'confirmed', label: 'Confirmed only', hint: 'corroborated tracks' },
              { value: 'any', label: 'Any track', hint: 'including weak hints' },
            ]}
            className="w-full"
          />
        </SettingRow>
      </SettingsCard>
    </>
  )
}
