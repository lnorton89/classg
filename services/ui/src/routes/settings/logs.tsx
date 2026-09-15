import { createFileRoute } from '@tanstack/react-router'
import { ScrollTextIcon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { Segmented } from '@/components/ui/segmented'
import { SettingRow, SettingsCard, ToggleRow } from '@/features/settings/controls'

export const Route = createFileRoute('/settings/logs')({ component: LogSettings })

function LogSettings() {
  const { preferences, setPreference } = usePreferences()

  return (
    <SettingsCard
      icon={ScrollTextIcon}
      title="Event log"
      description="The log is held in memory for this browser session, so both of these are gone when the tab is."
      why={
        <>
          A larger buffer keeps more history and costs more memory; the Pi this usually runs
          against has 4 GB, and the browser reading it may have much less. Oldest entries are
          dropped once the buffer is full. Following suspends automatically while you scroll
          back, so leaving it on does not fight you during a review.
        </>
      }
    >
      <SettingRow label="Buffer size">
        <Segmented
          aria-label="Log buffer size"
          value={String(preferences.logLimit)}
          onValueChange={(value) => setPreference('logLimit', Number(value))}
          options={[
            { value: '250', label: '250' },
            { value: '1000', label: '1,000' },
            { value: '5000', label: '5,000' },
          ]}
        />
      </SettingRow>

      <ToggleRow
        label="Follow new entries"
        hint="Scrolls to the newest entry as it arrives."
        checked={preferences.logFollow}
        onCheckedChange={(checked) => setPreference('logFollow', checked)}
      />
    </SettingsCard>
  )
}
