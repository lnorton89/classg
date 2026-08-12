import { createFileRoute } from '@tanstack/react-router'
import { ScrollTextIcon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { Segmented } from '@/components/ui/segmented'
import { SettingRow, SettingsCard, ToggleRow } from '@/features/settings/controls'

export const Route = createFileRoute('/settings/logs')({ component: LogSettings })

export function LogSettings() {
  const { preferences, setPreference } = usePreferences()

  return (
    <SettingsCard
      icon={ScrollTextIcon}
      title="Event log"
      description="The log is held in memory for this browser session. A larger buffer keeps more history and costs more memory — this box has 4 GB."
    >
      <SettingRow label="Buffer size" hint="Oldest entries are dropped once it is full.">
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
        hint="Scrolls to the newest entry as it arrives. Suspends automatically while you scroll back."
        checked={preferences.logFollow}
        onCheckedChange={(checked) => setPreference('logFollow', checked)}
      />
    </SettingsCard>
  )
}
