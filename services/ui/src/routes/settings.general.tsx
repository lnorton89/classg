import { createFileRoute } from '@tanstack/react-router'
import { ClockIcon, GlobeIcon, RulerIcon } from 'lucide-react'

import { usePreferences } from '@/app/preferences-context'
import { useFormat } from '@/app/use-format'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import {
  PreviewPanel,
  PreviewRow,
  SettingRow,
  SettingsCard,
} from '@/features/settings/controls'
import { log } from '@/features/logs/log-store'
import {
  COORD_FORMATS,
  TIMESTAMP_STYLES,
  UNIT_SYSTEMS,
  type ClockFormat,
  type CoordFormat,
  type TimestampStyle,
  type TimeZoneMode,
  type UnitSystem,
} from '@/lib/units'

export const Route = createFileRoute('/settings/general')({ component: GeneralSettings })

/**
 * A worked example for the time preview, fixed when the module loads rather
 * than read during render. It ages over a long session, which is fine — it is
 * demonstrating the format, and a genuinely relative sample demonstrates it
 * better than a hardcoded date would.
 */
const SAMPLE_TIMESTAMP = new Date(Date.now() - 254_000).toISOString()

function GeneralSettings() {
  const { preferences, setPreference } = usePreferences()
  const format = useFormat()

  return (
    <>
      <SettingsCard
        icon={RulerIcon}
        title="Units"
        description="Detections are recorded in SI and converted only for display, so switching this never alters a stored measurement."
      >
        <SettingRow label="Unit system" hint="Altitude, height above ground, speed and range.">
          <Segmented
            aria-label="Unit system"
            value={preferences.units}
            onValueChange={(value: UnitSystem) => {
              setPreference('units', value)
              log.action(`Units set to ${value}`)
            }}
            options={UNIT_SYSTEMS.map((system) => ({
              value: system.value,
              label: system.label,
              hint: system.hint,
            }))}
            className="w-full"
          />
        </SettingRow>

        <SettingRow
          label="Coordinate format"
          hint="Decimal degrees paste cleanly into mapping tools; degrees-and-minutes is what an aviation chart uses."
        >
          <Select
            aria-label="Coordinate format"
            value={preferences.coordFormat}
            onValueChange={(value: CoordFormat) => setPreference('coordFormat', value)}
            options={COORD_FORMATS.map((entry) => ({
              value: entry.value,
              label: `${entry.label} — ${entry.hint}`,
            }))}
            className="w-full max-w-md"
          />
        </SettingRow>

        <PreviewPanel title="With these settings">
          <PreviewRow label="Height AGL" value={format.length(122.4)} />
          <PreviewRow label="Ground speed" value={format.speed(14.2)} />
          <PreviewRow label="Operator range" value={format.range(1840)} />
          <PreviewRow label="Position" value={format.coords(51.4775, -0.0014)} />
        </PreviewPanel>
      </SettingsCard>

      <SettingsCard
        icon={ClockIcon}
        title="Time"
        description="UTC is the default because detections get correlated against sensor logs and other systems, and a timestamp that means something different on each machine costs an hour during a review."
      >
        <SettingRow label="Time zone" hint="Applies to every timestamp in the interface.">
          <Segmented
            aria-label="Time zone"
            value={preferences.timeZone}
            onValueChange={(value: TimeZoneMode) => setPreference('timeZone', value)}
            options={[
              { value: 'utc', label: 'UTC', hint: 'shared reference', icon: <GlobeIcon /> },
              { value: 'local', label: 'Local', hint: browserZone(), icon: <ClockIcon /> },
            ]}
          />
        </SettingRow>

        <SettingRow label="Clock">
          <Segmented
            aria-label="Clock format"
            value={preferences.clock}
            onValueChange={(value: ClockFormat) => setPreference('clock', value)}
            options={[
              { value: '24h', label: '24-hour' },
              { value: '12h', label: '12-hour' },
            ]}
          />
        </SettingRow>

        <SettingRow
          label="Timestamp style"
          hint="Relative reads faster; absolute is what goes in a report."
        >
          <Segmented
            aria-label="Timestamp style"
            value={preferences.timestampStyle}
            onValueChange={(value: TimestampStyle) => setPreference('timestampStyle', value)}
            options={TIMESTAMP_STYLES.map((entry) => ({
              value: entry.value,
              label: entry.label,
              hint: entry.hint,
            }))}
            className="w-full"
          />
        </SettingRow>

        <PreviewPanel title="A detection from four minutes ago">
          <PreviewRow label="Last seen" value={format.when(SAMPLE_TIMESTAMP)} />
          <PreviewRow label="Full timestamp" value={format.timestamp(SAMPLE_TIMESTAMP)} />
        </PreviewPanel>
      </SettingsCard>
    </>
  )
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'device time'
  } catch {
    return 'device time'
  }
}
