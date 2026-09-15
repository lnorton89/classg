import { createFileRoute, Link } from '@tanstack/react-router'
import { BellIcon, FilterIcon, Volume2Icon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Alert } from '@/components/ui/misc'
import { playAlert } from '@/lib/alert-sound'
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
        description="Switching a category off hides it from the bell and from the unread count. It never stops the receiver recording it."
        why={
          <>
            The bell collects recent drone activity alongside what this console saw happen, and
            these switches choose which of the two you are shown. Nothing here reaches the
            receiver: detection, fusion and storage carry on exactly as before, so a quiet
            drawer is a choice you made and not evidence of a quiet sky.
          </>
        }
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
        description="Applies to system events only, never to detections."
        why={
          <>
            Drone detections are all recorded at info, so a higher floor here would switch off
            the detections themselves rather than quieten them — which is what the categories
            above are for. Debug entries arrive in rate-limited bursts and are meant for the{' '}
            <Link to="/logs" className="text-primary underline-offset-2 hover:underline">
              event log
            </Link>
            , not for notifications.
          </>
        }
      >
        <SettingRow label="Minimum severity for system events">
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
        description="A short two-tone chirp, on a track's first appearance only."
        why={
          <>
            The realistic way this console is used is not being stared at, and a sound is what
            makes a continuously recording detector worth leaving on a bench. It fires once per
            track and never again while that drone loiters, because an alert that repeats is one
            you learn to ignore. Browsers only permit sound after you have interacted with the
            page at least once, which is what the test button below is for.
          </>
        }
      >
        <SettingRow label="Audible alert on new track">
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
        {/* An alert meant for an unattended bench has to be verifiable while
            somebody is still standing at it. Without this the first proof the
            chirp works — the volume is up, the browser allows audio, the
            speaker is not muted — was a real drone. */}
        <SettingRow
          label="Test the chirp"
          hint="Plays it once, at the volume an alert would use."
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => playAlert('confirmed')}
          >
            <Volume2Icon aria-hidden /> Play test chirp
          </Button>
        </SettingRow>
      </SettingsCard>
    </>
  )
}
