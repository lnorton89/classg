import { createFileRoute } from '@tanstack/react-router'
import {
  BellIcon,
  ClockIcon,
  EyeIcon,
  GlobeIcon,
  MonitorIcon,
  MoonIcon,
  RotateCcwIcon,
  RulerIcon,
  ScrollTextIcon,
  ShieldQuestionIcon,
  SlidersHorizontalIcon,
  SunIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useId } from 'react'

import { usePreferences, type Density, type TextScale } from '@/app/preferences-context'
import { useTheme, type ThemePreference } from '@/app/theme-context'
import { useFormat } from '@/app/use-format'
import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/field'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { log } from '@/features/logs/log-store'
import { cn } from '@/lib/cn'
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

export const Route = createFileRoute('/settings')({
  component: SettingsView,
})

/**
 * A worked example for the time preview, fixed when the module loads rather
 * than read during render. It ages over a long session, which is fine — it is
 * demonstrating the format, and a genuinely relative sample demonstrates it
 * better than a hardcoded date would.
 */
const SAMPLE_TIMESTAMP = new Date(Date.now() - 254_000).toISOString()

/**
 * Every control on this page applies instantly and is stored in this browser.
 * There is no Save button on purpose: nothing here can change what the system
 * detects, so the cost of a wrong click is one more click. `/config`, which
 * changes the instrument itself, keeps its explicit save-and-restart flow.
 */
function SettingsView() {
  const { preferences, setPreference, reset } = usePreferences()
  const { preference: theme, setPreference: setTheme } = useTheme()
  const format = useFormat()
  const toast = useToast()

  return (
    <PageContainer>
      <PageHeader
        icon={SlidersHorizontalIcon}
        title="Settings"
        description={
          <>
            How this console displays things. Stored in this browser only, applied immediately,
            and never able to change what the sensors detect — for that, see{' '}
            <span className="text-foreground font-medium">Config</span>.
          </>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              reset()
              log.action('Display settings reset to defaults')
              toast.add({ title: 'Settings reset', type: 'success' })
            }}
          >
            <RotateCcwIcon aria-hidden /> Reset to defaults
          </Button>
        }
      />

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RulerIcon className="text-muted-foreground size-4" aria-hidden />
            Units
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            Detections are recorded in SI and converted only for display, so switching this
            never alters a stored measurement.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingRow
            label="Unit system"
            hint="Altitude, height above ground, speed and range."
          >
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
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClockIcon className="text-muted-foreground size-4" aria-hidden />
            Time
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            UTC is the default because detections get correlated against sensor logs and other
            systems, and a timestamp that means something different on each machine costs an
            hour during a review.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <EyeIcon className="text-muted-foreground size-4" aria-hidden />
            Display
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            Dark is the default and stays the default: this runs outdoors at night, where a
            white screen costs night vision as well as legibility.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingRow label="Theme">
            <Segmented
              aria-label="Theme"
              value={theme}
              onValueChange={(value: ThemePreference) => setTheme(value)}
              options={[
                { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
                { value: 'light', label: 'Light', icon: <SunIcon /> },
                { value: 'system', label: 'System', icon: <MonitorIcon /> },
              ]}
            />
          </SettingRow>

          <SettingRow
            label="Text size"
            hint="Scales the whole interface, including map labels and table cells."
          >
            <Segmented
              aria-label="Text size"
              value={preferences.textScale}
              onValueChange={(value: TextScale) => setPreference('textScale', value)}
              options={[
                { value: 'sm', label: 'Small' },
                { value: 'md', label: 'Default' },
                { value: 'lg', label: 'Large' },
                { value: 'xl', label: 'Largest' },
              ]}
            />
          </SettingRow>

          <SettingRow
            label="Density"
            hint="Compact tightens table rows only. Buttons keep their 44px touch target either way."
          >
            <Segmented
              aria-label="Density"
              value={preferences.density}
              onValueChange={(value: Density) => setPreference('density', value)}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
            />
          </SettingRow>

          <ToggleRow
            label="Reduce motion"
            hint="Also honoured automatically when your operating system asks for it."
            checked={preferences.motion === 'reduced'}
            onCheckedChange={(checked) =>
              setPreference('motion', checked ? 'reduced' : 'system')
            }
          />
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BellIcon className="text-muted-foreground size-4" aria-hidden />
            Field use
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            For a console left running on a tripod or a bench rather than watched continuously.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingRow
            label="Audible alert on new track"
            hint="A short two-tone chirp. Browsers only permit sound after you have interacted with the page at least once."
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

          <ToggleRow
            label="Keep the screen awake"
            hint="Holds a wake lock while this tab is visible. Not supported in every browser."
            checked={preferences.keepAwake}
            onCheckedChange={(checked) => setPreference('keepAwake', checked)}
          />

          <ToggleRow
            icon={ShieldQuestionIcon}
            label="Confirm before restarting a sensor"
            hint="A restart drops coverage for several seconds. Off makes the button act immediately."
            checked={preferences.confirmDestructive}
            onCheckedChange={(checked) => setPreference('confirmDestructive', checked)}
          />
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollTextIcon className="text-muted-foreground size-4" aria-hidden />
            Event log
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            The log is held in memory for this browser session. A larger buffer keeps more
            history and costs more memory — this box has 4&nbsp;GB.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>
    </PageContainer>
  )
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'device time'
  } catch {
    return 'device time'
  }
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint ? (
          <p className="text-muted-foreground mt-0.5 max-w-2xl text-xs leading-relaxed">
            {hint}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onCheckedChange,
  icon: Icon,
}: {
  label: string
  hint?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  icon?: typeof BellIcon
}) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="flex items-center gap-2 text-sm">
          {Icon ? <Icon className="text-muted-foreground size-4" aria-hidden /> : null}
          {label}
        </Label>
        {hint ? (
          <p
            id={hintId}
            className="text-muted-foreground mt-0.5 max-w-2xl text-xs leading-relaxed"
          >
            {hint}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={hint ? hintId : undefined}
      />
    </div>
  )
}

function PreviewPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={cn('bg-muted/40 border-border rounded-md border p-3')}>
      <p className="label-caps">{title}</p>
      <dl className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">{children}</dl>
    </div>
  )
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  )
}
