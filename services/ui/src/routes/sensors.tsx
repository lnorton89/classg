/**
 * Sensors: one at a time.
 *
 * This was two pages — a grid of every sensor's health stacked above capture
 * history and a system card, and a completely separate "Spectrum" page with
 * its own segmented switch between the SDR sweep and Wi-Fi occupancy. That
 * split was never true to what the two radios are: the SDR sweep is the SDR
 * sensor's own measurement and Wi-Fi occupancy is the Wi-Fi sensor's, so
 * "spectrum" was really per-sensor detail that had been pulled out onto a
 * page of its own, reachable only if you already knew the two pages were
 * related.
 *
 * The list-detail pattern used here — a compact list of entities on one side,
 * the full detail of whichever one is selected on the other — is the same
 * shape as an email client, a settings app, or a device manager: exactly the
 * form for "a handful of things, one thing at a time deserves the room."
 * Desktop keeps both panes on screen together, because there are rarely more
 * than three or four sensors and comparing them costs nothing extra. A phone
 * has room for one pane, so selecting an entry there replaces the list with
 * its detail and a way back — the same pattern this app already uses for a
 * track's detail view, just without leaving the page.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArchiveIcon,
  ArrowLeftIcon,
  AudioWaveformIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { usePreferences } from '@/app/preferences-context'
import { useFormat, useTicker } from '@/app/use-format'
import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { KeyValueGroup } from '@/components/ui/key-value-group'
import { Alert, EmptyState } from '@/components/ui/misc'
import { Why } from '@/components/ui/why'
import { useToast } from '@/components/ui/toast-primitives'
import { captureLimitation } from '@/features/captures/capture-limits'
import { SensorCaptureControl } from '@/features/captures/sensor-captures'
import { SensorHealthCard } from '@/features/health/components'
import { SENSOR_ICONS } from '@/features/health/sensor-icons'
import { log } from '@/features/logs/log-store'
import { WifiOccupancyPanel } from '@/features/spectrum/wifi-occupancy'
import { ApiError, api } from '@/lib/api/client'
import { capturesQuery, healthQuery, queryKeys, sensorsQuery } from '@/lib/api/queries'
import type { RestartSensorResponse, SensorHealth } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { EMPTY } from '@/lib/format'

// In the URL, not component state, so a reload or a shared link lands back on
// the sensor someone was reading instead of resetting to the first every time.
//
// `view=captures` used to live here too, selecting a captures pane inside this
// page. `/captures` is a real route now, so the pane was a second copy of the
// same list at a URL that only this page understood -- and a link that landed
// there had no way to say which of the two an operator meant. The sensor list
// keeps a count and a link; the list and its detail live on `/captures` alone.
export const sensorsSearchSchema = z.object({
  sensor: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/sensors')({
  component: SensorsView,
  validateSearch: sensorsSearchSchema,
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(healthQuery()),
      context.queryClient.ensureQueryData(sensorsQuery()),
      context.queryClient.ensureQueryData(capturesQuery()),
    ])
  },
})

export function SensorsView() {
  const queryClient = useQueryClient()
  const { data: health } = useQuery(healthQuery())
  const { data: sensorsData } = useQuery(sensorsQuery())
  const { data: capturesData } = useQuery(capturesQuery())
  const toast = useToast()
  const { preferences } = usePreferences()
  // Which sensor is awaiting a second click. A restart drops coverage for
  // several seconds, and on a phone the button sits directly under a thumb.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const navigate = useNavigate({ from: Route.fullPath })
  const search = Route.useSearch()
  // Undefined until something is explicitly picked. Desktop falls back to
  // the first entry below so its detail pane is never empty; a phone stays
  // on the list until the operator taps something, per the pattern this
  // reads from — see the file header.
  const selected = search.sensor

  // replace: true -- switching the selected sensor is not a new page to walk
  // back through with the browser's back button, the way opening this page was.
  function selectSensor(id: string) {
    void navigate({ search: () => ({ sensor: id }), replace: true })
  }
  function goBack() {
    void navigate({ search: () => ({ sensor: undefined }), replace: true })
  }

  const restart = useMutation({
    mutationFn: (sensorId: string) => api.restartSensor(sensorId),
    onMutate: (sensorId) => log.action(`Restart requested for ${sensorId}`),
    onSuccess: (result) => {
      setConfirmingId(null)
      toast.add({
        title: `Restart accepted for ${result.sensor_id}`,
        description: `${result.unit} is restarting. Coverage resumes when it heartbeats again.`,
        type: 'success',
      })
      log.info('sensor', `Restart accepted for ${result.sensor_id}`, { unit: result.unit })
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: queryKeys.sensors })
    },
    onError: () => setConfirmingId(null),
  })
  const restartError = restart.error instanceof ApiError ? restart.error : null

  const sensors = sensorsData ?? health?.sensors ?? []
  const captures = capturesData?.captures ?? []

  const effective = selected ?? sensors[0]?.sensor_id
  const selectedSensor = sensors.find((s) => s.sensor_id === effective)

  return (
    <PageContainer>
      <PageHeader
        icon={SlidersHorizontalIcon}
        title="Sensors"
        description="Coverage and recordings for one sensor at a time — pick a sensor to see what it measures and manage it."
        // The way back out of a selection, in the same slot every other detail
        // view puts it. Only below lg, where selecting replaces the list: on a
        // wide screen both panes are on screen and there is nothing to go back
        // to.
        eyebrow={
          selected ? (
            <button
              type="button"
              onClick={goBack}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded text-xs lg:hidden"
            >
              <ArrowLeftIcon className="size-3.5" aria-hidden /> All sensors
            </button>
          ) : null
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {/* min-w-0 so a long sensor id truncates instead of widening the column. */}
        <nav
          aria-label="Sensors"
          className={cn(
            'border-border bg-card/70 min-w-0 flex-col gap-3 rounded-lg border p-2 lg:sticky lg:top-20 lg:flex',
            selected ? 'hidden lg:flex' : 'flex',
          )}
        >
          <ul className="space-y-0.5">
            {sensors.map((sensor) => (
              <li key={sensor.sensor_id}>
                <SensorRow
                  sensor={sensor}
                  active={effective === sensor.sensor_id}
                  onSelect={() => selectSensor(sensor.sensor_id)}
                />
              </li>
            ))}
            {sensors.length === 0 ? (
              <li className="text-muted-foreground px-2.5 py-2 text-xs">
                No sensors are reporting.
              </li>
            ) : null}
          </ul>

          {/* One line and a link, not a pane. The recordings are their own
              route now, and a second copy of that list inside this page meant
              two places to look and two URLs that meant the same thing. What
              belongs here is the count -- a recording is made BY a sensor, so
              "does this unit have any" is a fair question to answer on the
              sensor page -- and the way to the list. Starting one is still a
              per-sensor action, in that sensor's own detail. */}
          <div className="border-border border-t pt-2">
            <Link
              to="/captures"
              className="text-muted-foreground hover:bg-accent/50 hover:text-foreground flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors"
            >
              <ArchiveIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm">
                {captures.length === 1 ? '1 recording' : `${captures.length} recordings`}
              </span>
              <span className="shrink-0 text-xs">Captures →</span>
            </Link>
          </div>

          <SystemFooter
            status={health?.status}
            uptimeS={health?.uptime_s}
            version={health?.version}
          />
        </nav>

        {/* min-w-0 so a wide child -- the spectrum charts -- scrolls inside its
            own container instead of stretching the grid column. */}
        <div className={cn('min-w-0 flex-col gap-3', selected ? 'flex' : 'hidden lg:flex')}>
          {/* The way back lives in the page header's eyebrow now, with every
              other detail view's. */}
          {selectedSensor ? (
            <SensorDetail
              key={selectedSensor.sensor_id}
              sensor={selectedSensor}
              restart={restart}
              restartError={restartError}
              confirmingId={confirmingId}
              onConfirm={setConfirmingId}
              confirmDestructive={preferences.confirmDestructive}
            />
          ) : (
            <EmptyState icon={SlidersHorizontalIcon} title="No sensors are reporting">
              A sensor appears here as soon as this unit hears its first heartbeat.
            </EmptyState>
          )}
        </div>
      </div>
    </PageContainer>
  )
}

function SensorRow({
  sensor,
  active,
  onSelect,
}: {
  sensor: SensorHealth
  active: boolean
  onSelect: () => void
}) {
  const format = useFormat()
  // Heartbeat age has to advance on its own -- a row frozen at "3s ago" is
  // exactly the lie this page exists to prevent.
  useTicker(5000)
  const Icon = SENSOR_ICONS[sensor.sensor_kind]

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      data-sensor-id={sensor.sensor_id}
      data-healthy={sensor.healthy}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className={cn('size-4 shrink-0', !sensor.healthy && 'text-down')} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-foreground truncate font-mono text-sm">{sensor.sensor_id}</span>
          {!sensor.healthy ? (
            <span className="bg-down inline-block size-1.5 shrink-0 rounded-full" aria-hidden />
          ) : null}
        </span>
        <span className="text-muted-foreground block truncate text-2xs">
          {/* Spelled out: this was the one place in the app that said "det",
              and an abbreviation that exists nowhere else is jargon. */}
          {sensor.healthy
            ? `${format.relative(sensor.last_heartbeat)}${
                sensor.detections_5m !== undefined
                  ? ` · ${sensor.detections_5m} detections`
                  : ''
              }`
            : 'unhealthy'}
        </span>
      </span>
    </button>
  )
}

function SystemFooter({
  status,
  uptimeS,
  version,
}: {
  status: string | undefined
  uptimeS: number | undefined
  version: string | undefined
}) {
  const format = useFormat()
  return (
    <div className="border-border border-t pt-2">
      <KeyValueGroup
        entries={[
          { id: 'status', label: 'Status', value: status ?? EMPTY, mono: true },
          {
            id: 'uptime',
            label: 'Uptime',
            value: uptimeS !== undefined ? format.duration(uptimeS) : EMPTY,
            mono: true,
          },
          { id: 'version', label: 'Version', value: version ?? EMPTY, mono: true },
        ]}
      />
      {/* The rule an operator needs once and then knows. It was three lines of
          standing prose at the bottom of the nav column, which is a lot of the
          only rail this page has for a sentence nobody re-reads. */}
      <Why label="What does zero detections mean?" className="mt-2">
        Zero detections from a <em>healthy</em> sensor is a quiet sky. Zero from an{' '}
        <em>unhealthy</em> one means nothing — do not trust the quiet.
      </Why>
    </div>
  )
}

function SensorDetail({
  sensor,
  restart,
  restartError,
  confirmingId,
  onConfirm,
  confirmDestructive,
}: {
  sensor: SensorHealth
  restart: ReturnType<typeof useMutation<RestartSensorResponse, Error, string>>
  restartError: ApiError | null
  confirmingId: string | null
  onConfirm: (id: string | null) => void
  confirmDestructive: boolean
}) {
  const config = sensor.config
  const restartAvailable = config?.restart_available ?? true
  const isRestarting = restart.isPending && restart.variables === sensor.sensor_id
  const isConfirming = confirmingId === sensor.sensor_id
  const restartFailed = restart.isError && restart.variables === sensor.sensor_id

  // Collected rather than rendered where each is discovered: separately they
  // are two alerts, together they are one sentence about the build.
  const limitations = [
    restartAvailable
      ? null
      : (config?.restart_unavailable_reason ??
        'no restart command is available in the API runtime'),
    captureLimitation(sensor),
  ].filter((limit): limit is string => limit !== null)

  // Wi-Fi occupancy is the Wi-Fi sensor's own measurement, and the panel is
  // told WHICH Wi-Fi sensor: it used to take the first one it found, which was
  // the same thing while there was only one, and became wrong the day a second
  // receiver arrived -- selecting wifi-1 rendered a card measuring wifi-0's
  // radio, under wifi-1's heading.
  //
  // The SDR's band sweep used to sit here on the same reasoning, and it is the
  // one that did not hold: a sweep is a task an operator comes to the console
  // to perform and compare over weeks, not a reading to glance at, and buried
  // under a health card it was reachable only by already knowing it existed.
  // It has its own page again; the card keeps a link to it.
  const spectrum =
    sensor.sensor_kind === 'wifi' ? <WifiOccupancyPanel sensorId={sensor.sensor_id} /> : null

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {restartFailed ? (
        <Alert tone="error" title="Restart failed">
          {restartError?.message ??
            (restart.error instanceof Error ? restart.error.message : 'Unknown error')}
        </Alert>
      ) : null}

      {/* The API has always sent `expected` and nothing rendered it, which is
          the worst possible pairing for this particular flag: an undeclared
          sensor looks completely normal right up until it dies, and then it
          does not appear as unhealthy — it disappears, and /health stays "ok"
          with one fewer receiver. There is no later moment at which to notice.
          The live unit declares only wifi-0, so both the SDR and the second
          Wi-Fi receiver are currently in this state. */}
      {config && !config.expected ? (
        <Alert tone="warn" title="Not declared, so its failure would be silent">
          <span className="font-mono">{sensor.sensor_id}</span> is heartbeating but is not in{' '}
          <code className="font-mono">sensors.expected</code>. Undeclared sensors are listed
          only while they are alive: if this one stops, it vanishes from the sensor list and
          overall health stays <span className="font-mono">ok</span> rather than degrading. Add{' '}
          <code className="font-mono">
            {sensor.sensor_id}:{sensor.sensor_kind}
            {sensor.optional ? ':optional' : ''}
          </code>{' '}
          under{' '}
          <Link to="/settings/calibration" className="underline underline-offset-2">
            Settings &rsaquo; Calibration
          </Link>
          .
        </Alert>
      ) : null}

      <div className={cn('grid min-w-0 items-start gap-4', spectrum && 'xl:grid-cols-2')}>
        <SensorHealthCard
          sensor={sensor}
          // The one primary card on this page: the selected sensor is what the
          // page is for, and the spectrum panel beside it is what that sensor
          // happens to measure.
          weight="primary"
          action={
            <div className="mt-3">
              {/* No restart control, and no box explaining its absence: the
                  reason is a property of this build, not a fault, and it is
                  collected into the one muted line below with the other. */}
              {!restartAvailable ? null : isConfirming ? (
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    disabled={restart.isPending}
                    onClick={() => restart.mutate(sensor.sensor_id)}
                  >
                    <RotateCwIcon aria-hidden />
                    Confirm restart — drops coverage
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onConfirm(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  disabled={restart.isPending || !restartAvailable}
                  onClick={() =>
                    confirmDestructive
                      ? onConfirm(sensor.sensor_id)
                      : restart.mutate(sensor.sensor_id)
                  }
                >
                  <RotateCwIcon aria-hidden />
                  {isRestarting ? 'Restarting…' : 'Restart'}
                </Button>
              )}
              <SensorCaptureControl sensor={sensor} />
              {/* The sweep tool moved to its own page; this is the trail
                  between the measurement and the radio that takes it. */}
              {sensor.sensor_kind === 'sdr' ? (
                <Link
                  to="/spectrum"
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'mt-2 w-full',
                  )}
                >
                  <AudioWaveformIcon aria-hidden />
                  Band sweeps →
                </Link>
              ) : null}
              {/* One muted line, last. These were two permanent error-styled
                  boxes describing what this BUILD cannot do -- systemctl is
                  not reachable from the API container, capture is unwritten
                  for SDR sensors -- which on a unit where both are always true
                  meant the sensor page opened on two red-edged alerts about
                  nothing being wrong. A fault gets an alert; a build does not. */}
              {limitations.length > 0 ? (
                <p className="text-muted-foreground border-border mt-3 border-t pt-3 text-2xs leading-relaxed">
                  Not available in this build: {limitations.join('; ')}.
                </p>
              ) : null}
            </div>
          }
        />
        {spectrum}
      </div>
    </div>
  )
}
