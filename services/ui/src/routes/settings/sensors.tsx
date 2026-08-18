import { createFileRoute } from '@tanstack/react-router'
import { ShieldQuestionIcon, SlidersHorizontalIcon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { SettingsCard, ToggleRow } from '@/features/settings/controls'

export const Route = createFileRoute('/settings/sensors')({ component: SensorSettings })

function SensorSettings() {
  const { preferences, setPreference } = usePreferences()

  return (
    <SettingsCard
      icon={SlidersHorizontalIcon}
      title="Sensors"
      description="How the Sensors page behaves when you act on a sensor. What the sensors themselves do is set under Calibration."
    >
      <ToggleRow
        icon={ShieldQuestionIcon}
        label="Confirm before restarting a sensor"
        hint="A restart drops coverage for several seconds. Off makes the button act immediately."
        checked={preferences.confirmDestructive}
        onCheckedChange={(checked) => setPreference('confirmDestructive', checked)}
      />
    </SettingsCard>
  )
}
