import { createFileRoute } from '@tanstack/react-router'
import { ArchiveIcon, MapIcon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { SettingsCard, ToggleRow } from '@/features/settings/controls'

export const Route = createFileRoute('/settings/map')({ component: MapSettings })

function MapSettings() {
  const { preferences, setPreference } = usePreferences()

  return (
    <SettingsCard
      icon={MapIcon}
      title="Live map"
      description="What the map and its contacts panel show alongside the aircraft. Neither of these changes what is detected or plotted — only how much of it is on screen at once."
    >
      <ToggleRow
        label="Show the legend"
        hint="Three of the four things on the map are easy to confuse — a drone, a manned aircraft, and a person on the ground. Worth leaving on until the symbols are second nature."
        checked={preferences.mapLegend}
        onCheckedChange={(checked) => setPreference('mapLegend', checked)}
      />

      <ToggleRow
        icon={ArchiveIcon}
        label="Show closed tracks in the contacts panel"
        hint="Tracks that have ended stay listed for review. Turning this off shortens the panel during a busy watch; the tracks are still recorded and still on the Tracks page."
        checked={preferences.showClosedContacts}
        onCheckedChange={(checked) => setPreference('showClosedContacts', checked)}
      />
    </SettingsCard>
  )
}
