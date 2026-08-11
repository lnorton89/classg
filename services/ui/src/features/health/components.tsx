import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ActivityIcon,
  AntennaIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  PlugZapIcon,
  RadioIcon,
  TriangleAlertIcon,
  WifiIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { useLive } from '@/app/live-provider'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DataRow } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { useFormat, useTicker } from '@/app/use-format'
import { healthQuery } from '@/lib/api/queries'
import type { SensorHealth, SensorKind, SystemStatus } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import { formatDetailValue } from './detail-format'
import type { SkyState } from './sky-state'

const SENSOR_ICONS: Record<SensorKind, typeof WifiIcon> = {
  wifi: WifiIcon,
  sdr: RadioIcon,
  ble: AntennaIcon,
}

const STATUS_LABEL: Record<SystemStatus, string> = {
  ok: 'All sensors healthy',
  degraded: 'Sensor degraded',
  down: 'No coverage',
}

/**
 * The persistent system-status pill in the header. Present on every route,
 * because "is this thing actually working" is not a question that belongs on a
 * separate page you have to remember to visit.
 */
export function SystemStatusPill({ className }: { className?: string }) {
  const { data: health, isPending, isError } = useQuery(healthQuery())

  if (isPending || isError || !health) {
    return (
      <span
        className={cn(
          'border-border text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
          className,
        )}
      >
        <CircleSlashIcon className="size-3.5" aria-hidden />
        {isError ? 'API unreachable' : 'Checking sensors…'}
      </span>
    )
  }

  const unhealthy = health.sensors.filter((s) => !s.healthy)
  const tone = health.status === 'ok' ? 'ok' : health.status === 'degraded' ? 'warn' : 'down'
  const Icon =
    health.status === 'ok'
      ? CircleCheckIcon
      : health.status === 'down'
        ? PlugZapIcon
        : TriangleAlertIcon

  return (
    <Link
      to="/sensors"
      className={cn('rounded-md', className)}
      aria-label={`System status: ${STATUS_LABEL[health.status]}. ${
        unhealthy.length
      } of ${health.sensors.length} sensors unhealthy. Open sensor health.`}
    >
      <Badge variant={tone} className="h-7 gap-1.5 px-2">
        <Icon className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">{STATUS_LABEL[health.status]}</span>
        <span className="sm:hidden">
          {health.sensors.length - unhealthy.length}/{health.sensors.length}
        </span>
      </Badge>
    </Link>
  )
}

/** Live-stream connection indicator. A dead socket means stale data, not calm. */
export function StreamStatusPill({ className }: { className?: string }) {
  const { connection, lastFrameAt, reconnectAttempt } = useLive()
  const format = useFormat()
  // Per second, unlike the heavier lists: this pill is the freshness indicator,
  // and it renders one badge. "Last frame 3s ago" going stale here would
  // undermine the one thing it exists to tell you.
  useTicker(1000)

  const map = {
    open: { tone: 'ok' as const, label: 'Live', icon: ActivityIcon },
    connecting: { tone: 'muted' as const, label: 'Connecting…', icon: ActivityIcon },
    reconnecting: {
      tone: 'warn' as const,
      label: `Reconnecting (${reconnectAttempt})`,
      icon: TriangleAlertIcon,
    },
    closed: { tone: 'down' as const, label: 'Stream offline', icon: CircleSlashIcon },
  }[connection]
  const Icon = map.icon

  return (
    <Tooltip
      content={
        connection === 'open'
          ? `Last frame ${format.relative(
              lastFrameAt ? new Date(lastFrameAt).toISOString() : null,
            )}. Tracks are refetched on every reconnect, so gaps do not persist.`
          : 'The live stream is not connected. Track positions on screen may be stale.'
      }
    >
      <Badge variant={map.tone} className={cn('h-7 gap-1.5 px-2', className)}>
        <Icon className="size-3.5" aria-hidden />
        <span className="hidden md:inline">{map.label}</span>
      </Badge>
    </Tooltip>
  )
}

/**
 * The banner that answers "what does this map mean". Rendered over the map, and
 * styled hard: a degraded system must not be a subtle grey note.
 */
export function SkyStateBanner({
  state,
  className,
  action,
}: {
  state: SkyState
  className?: string
  action?: ReactNode
}) {
  const tone = {
    ok: 'border-ok/35 bg-ok/12',
    warn: 'border-warn/50 bg-warn/15',
    down: 'border-down/55 bg-down/18',
    muted: 'border-border bg-muted/60',
  }[state.tone]

  const iconTone = {
    ok: 'text-ok',
    warn: 'text-warn',
    down: 'text-down',
    muted: 'text-muted-foreground',
  }[state.tone]

  const Icon = {
    ok: CircleCheckIcon,
    warn: TriangleAlertIcon,
    down: PlugZapIcon,
    muted: CircleSlashIcon,
  }[state.tone]

  return (
    <div
      // Assertive only when the operator must not trust the screen.
      role={state.absenceIsEvidence ? 'status' : 'alert'}
      aria-live={state.absenceIsEvidence ? 'polite' : 'assertive'}
      data-sky-state={state.kind}
      data-absence-is-evidence={state.absenceIsEvidence}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-lg border px-3 py-2 backdrop-blur-sm',
        tone,
        className,
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconTone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-tight font-semibold">{state.title}</p>
        <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{state.detail}</p>
      </div>
      {action}
    </div>
  )
}

export function SensorHealthCard({
  sensor,
  action,
}: {
  sensor: SensorHealth
  action?: ReactNode
}) {
  const format = useFormat()
  // Heartbeat age has to advance on its own — a card frozen at "3s ago" is
  // exactly the lie this page exists to prevent. Five seconds is well inside
  // the 30 s staleness threshold it is being read against.
  useTicker(5000)
  const Icon = SENSOR_ICONS[sensor.sensor_kind]
  return (
    <Card
      className={cn('overflow-hidden', !sensor.healthy && 'border-down/50 bg-down/[0.06]')}
      data-sensor-id={sensor.sensor_id}
      data-healthy={sensor.healthy}
    >
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 font-mono">
          <Icon className="text-muted-foreground size-4" aria-hidden />
          {sensor.sensor_id}
        </CardTitle>
        <Badge variant={sensor.healthy ? 'ok' : 'down'}>
          {sensor.healthy ? 'healthy' : 'unhealthy'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {!sensor.healthy && sensor.reason ? (
          <p className="border-down/40 bg-down/10 text-foreground rounded-md border px-2 py-1.5 text-xs">
            {sensor.reason}
          </p>
        ) : null}

        <dl>
          <DataRow
            label="Last heartbeat"
            value={
              <span className={cn(!sensor.healthy && 'text-down font-medium')}>
                {format.relative(sensor.last_heartbeat)} (
                {format.duration(sensor.seconds_since_heartbeat)})
              </span>
            }
          />
          <DataRow
            label="Detections (5 min)"
            value={
              sensor.detections_5m === undefined ? (
                '—'
              ) : sensor.detections_5m === 0 && sensor.healthy ? (
                <Tooltip content="Zero detections from a healthy sensor is a quiet sky, not a fault.">
                  <span className="text-muted-foreground underline decoration-dotted">
                    0 — quiet
                  </span>
                </Tooltip>
              ) : (
                String(sensor.detections_5m)
              )
            }
          />
          {Object.entries(sensor.detail ?? {}).map(([key, value]) => (
            <DataRow
              key={key}
              label={key.replaceAll('_', ' ')}
              value={formatDetailValue(value)}
              mono
            />
          ))}
        </dl>
        {action}
      </CardContent>
    </Card>
  )
}
