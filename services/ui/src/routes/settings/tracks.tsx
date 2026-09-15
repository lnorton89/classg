import { createFileRoute } from '@tanstack/react-router'
import { RouteIcon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { Segmented } from '@/components/ui/segmented'
import { PATH_COLOUR_LABELS, PATH_COLOUR_MODES } from '@/features/map/path-colour'
import { SettingRow, SettingsCard } from '@/features/settings/controls'

export const Route = createFileRoute('/settings/tracks')({ component: TrackSettings })

/**
 * What used to live here was "Track detail layout — reset card order", the
 * escape hatch for a detail page built as six draggable cards. The page now has
 * a fixed hierarchy (docs/research/08-tracks-ux.md), the drag-to-reorder store
 * is gone, and so is the control that forgot it.
 *
 * The one track preference left is a display choice about the detail map, which
 * is browser-scoped like everything else in this half of the settings: it
 * cannot change a measurement, only which one the map answers with first.
 */
function TrackSettings() {
  const { preferences, setPreference } = usePreferences()

  return (
    <SettingsCard
      icon={RouteIcon}
      title="Flight path"
      description="What the shading on the track detail map's path means. The recorded path is the same either way."
      why={
        <>
          Speed shades each leg from dim to bright within the track colour and marks hovers as
          dots; Time shades it from the start of the flight to its end; None draws one flat
          line, which is what the live map always does. A reception gap is dashed under all
          three and never shaded, because nothing measured it.
        </>
      }
    >
      <SettingRow label="Colour the path by">
        <Segmented
          aria-label="Colour the flight path by"
          value={preferences.trackPathColour}
          onValueChange={(value) => {
            setPreference('trackPathColour', value)
          }}
          options={PATH_COLOUR_MODES.map((mode) => ({
            value: mode,
            label: PATH_COLOUR_LABELS[mode],
          }))}
        />
      </SettingRow>
    </SettingsCard>
  )
}
