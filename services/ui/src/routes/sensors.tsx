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
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ArchiveIcon,
  ArrowLeftIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { usePreferences } from '@/app/preferences-context'
import { useFormat, useTicker } from '@/app/use-format'
import { PageContainer } from '@/components/layout/page-container'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Alert, DataRow, EmptyState } from '@/components/ui/misc'
import { useToast } from '@/components/ui/toast-primitives'
import { CaptureHistory, SensorCaptureControl } from '@/features/captures/sensor-captures'
import { SensorHealthCard } from '@/features/health/components'
import { SENSOR_ICONS } from '@/features/health/sensor-icons'
import { log } from '@/features/logs/log-store'
import { SpectrumPanel } from '@/features/spectrum/spectrum-panel'
import { WifiOccupancyPanel } from '@/features/spectrum/wifi-occupancy'
import { ApiError, api } from '@/lib/api/client'
import { capturesQuery, healthQuery, queryKeys, sensorsQuery } from '@/lib/api/queries'
import type { RestartSensorResponse, SensorHealth } from '@/lib/api/types'
import { cn } from '@/lib/cn'

// In the URL, not component state, so a reload or a shared link lands back
// on the sensor (or Captures) someone was reading instead of resetting to
// the first sensor every time.
export const sensorsSearchSchema = z.object({
  sensor: z.string().optional().catch(undefined),
  view: z.literal('captures').optional().catch(undefined),
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

type Selection = { kind: 'sensor'; id: string } | { kind: 'captures' }

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
  const selected: Selection | undefined =
    search.view === 'captures'
      ? { kind: 'captures' }
      : search.sensor
        ? { kind: 'sensor', id: search.sensor }
        : undefined

  // replace: true -- switching the selected sensor is not a new page to walk
  // back through with the browser's back button, the way opening this page was.
  function selectSensor(id: string) {
    void navigate({ search: () => ({ sensor: id, view: undefined }), replace: true })
  }
  function selectCaptures() {
    void navigate({ search: () => ({ sensor: undefined, view: 'captures' }), replace: true })
  }
  function goBack() {
    void navigate({ search: () => ({ sensor: undefined, view: undefined }), replace: true })
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

  const defaultSelection: Selection | null = sensors[0]
    ? { kind: 'sensor', id: sensors[0].sensor_id }
    : captures.length > 0
      ? { kind: 'captures' }
      : null
  const effective = selected ?? defaultSelection
  const selectedSensor =
    effective?.kind === 'sensor' ? sensors.find((s) => s.sensor_id === effective.id) : undefined

  return (
    <PageContainer>
      <PageHeader
        icon={SlidersHorizontalIcon}
        title="Sensors"
        description="Coverage, spectrum, and recordings for one sensor at a time — pick a sensor to see what it measures and manage it."
      />

      <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {/* min-w-0 so a long sensor id truncates instead of widening the column. */}
        <nav
          aria-label="Sensors and captures"
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
                  active={effective?.kind === 'sensor' && effective.id === sensor.sensor_id}
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

          <div className="border-border border-t pt-2">
            <ListEntry
              icon={ArchiveIcon}
              label="Captures"
              caption={captures.length === 1 ? '1 recording' : `${captures.length} recordings`}
              active={effective?.kind === 'captures'}
              onSelect={selectCaptures}
            />
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
          <button
            type="button"
            onClick={goBack}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start rounded text-xs lg:hidden"
          >
            <ArrowLeftIcon className="size-3.5" aria-hidden /> All sensors
          </button>

          {effective?.kind === 'captures' ? (
            <CaptureHistory />
          ) : selectedSensor ? (
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

function ListEntry({
  icon: Icon,
  label,
  caption,
  active,
  onSelect,
}: {
  icon: LucideIcon
  label: string
  caption: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="text-muted-foreground block truncate text-2xs">{caption}</span>
      </span>
    </button>
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
          {sensor.healthy
            ? `${format.relative(sensor.last_heartbeat)}${
                sensor.detections_5m !== undefined ? ` · ${sensor.detections_5m} det` : ''
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
      <dl>
        <DataRow label="Status" value={status ?? '—'} mono />
        <DataRow
          label="Uptime"
          value={uptimeS !== undefined ? format.duration(uptimeS) : '—'}
          mono
        />
        <DataRow label="Version" value={version ?? '—'} mono />
      </dl>
      <p className="text-muted-foreground mt-1 text-2xs leading-relaxed">
        Zero detections from a <em>healthy</em> sensor is a quiet sky. Zero from an{' '}
        <em>unhealthy</em> one means nothing — do not trust the quiet.
      </p>
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

  // The SDR sweep is the SDR sensor's own measurement and Wi-Fi occupancy is
  // the Wi-Fi sensor's -- see the file header. Neither panel takes a sensor
  // prop because each already scopes itself to the one sensor of that kind.
  const spectrum =
    sensor.sensor_kind === 'wifi' ? (
      <WifiOccupancyPanel />
    ) : sensor.sensor_kind === 'sdr' ? (
      <SpectrumPanel />
    ) : null

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
          to <code className="font-mono">CLASSG_EXPECTED_SENSORS</code>.
        </Alert>
      ) : null}

      <div className={cn('grid min-w-0 items-start gap-4', spectrum && 'xl:grid-cols-2')}>
        <SensorHealthCard
          sensor={sensor}
          action={
            <div className="mt-3">
              {!restartAvailable ? (
                <Alert tone="warn" title="Restart unavailable">
                  {config?.restart_unavailable_reason ??
                    'No restart command is available in the API runtime.'}
                </Alert>
              ) : null}
              {isConfirming ? (
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
            </div>
          }
        />
        {spectrum}
      </div>
    </div>
  )
}
