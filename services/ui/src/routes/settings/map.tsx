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
      description="How much of the map's own furniture is on screen at once. Neither of these changes what is detected or plotted."
      why={
        <>
          The legend is worth leaving on until the symbols are second nature: a drone, a manned
          aircraft and a person on the ground are three of the four things drawn, and they are
          easy to confuse. Closed tracks stay listed for review whether or not the contacts
          panel shows them — they are recorded either way, and the Tracks page has all of them.
        </>
      }
    >
      <ToggleRow
        label="Show the legend"
        checked={preferences.mapLegend}
        onCheckedChange={(checked) => setPreference('mapLegend', checked)}
      />

      <ToggleRow
        icon={ArchiveIcon}
        label="Show closed tracks in the contacts panel"
        hint="Shortens the panel during a busy watch."
        checked={preferences.showClosedContacts}
        onCheckedChange={(checked) => setPreference('showClosedContacts', checked)}
      />
    </SettingsCard>
  )
}
