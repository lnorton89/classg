import {
  AntennaIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CloudIcon,
  PlugZapIcon,
  RadioIcon,
  TriangleAlertIcon,
  WifiIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DataRow } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { useFormat, useTicker } from '@/app/use-format'
import type { SensorHealth, SensorKind } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import { formatDetailValue } from './detail-format'
import type { SkyState } from './sky-state'

const SENSOR_ICONS: Record<SensorKind, typeof WifiIcon> = {
  wifi: WifiIcon,
  sdr: RadioIcon,
  ble: AntennaIcon,
  // A cloud, not an antenna. A `net` source is somebody else's receiver reached
  // over the uplink, and an operator reading this page needs to see at a glance
  // that it proves nothing about what *this* unit can hear.
  net: CloudIcon,
}

/**
 * The persistent system-status pill in the header. Present on every route,
 * because "is this thing actually working" is not a question that belongs on a
 * separate page you have to remember to visit.
 */
/**
 * Whether this banner may be dismissed, and it is one condition.
 *
 * `absenceIsEvidence` is true exactly when the sensors are healthy and an
 * empty map therefore means an empty sky. That is the reassurance case, it is
 * on screen most of the time, and it is the one that becomes furniture -- so
 * it gets a close control and fades on its own.
 *
 * Every other state says some part of the sky is unwatched, and those stay
 * until they stop being true. Being able to clear "no sensor coverage" would
 * make an empty map with a dead sensor look like an empty map with a healthy
 * one, which is the single failure this whole interface is built to refuse.
 */
const QUIET_SKY_DISMISS_MS = 20_000

export function SkyStateBanner({
  state,
  className,
  action,
}: {
  state: SkyState
  className?: string
  action?: ReactNode
}) {
  // Keyed on the state's KIND, so dismissing "quiet sky" does not also hide
  // the "coverage degraded" that replaces it a minute later. Any change in
  // what the banner says brings it back.
  const [dismissedKind, setDismissedKind] = useState<string | null>(null)
  const dismissible = state.absenceIsEvidence
  const dismissed = dismissible && dismissedKind === state.kind

  useEffect(() => {
    if (!dismissible) return
    const id = setTimeout(() => setDismissedKind(state.kind), QUIET_SKY_DISMISS_MS)
    return () => clearTimeout(id)
  }, [dismissible, state.kind])

  if (dismissed) return null

  // Opaque, with severity carried by a left accent bar rather than a wash.
  // This banner sits ON TOP OF THE MAP on the Live route, and a 12-18% tint
  // over satellite imagery left the detail line -- the sentence saying whether
  // an empty map is evidence -- unreadable against terrain. The one thing this
  // component exists to communicate was the thing you could not read.
  const tone = {
    ok: 'border-border border-l-4 border-l-ok bg-card',
    warn: 'border-border border-l-4 border-l-warn bg-card',
    down: 'border-border border-l-4 border-l-down bg-card',
    muted: 'border-border border-l-4 border-l-muted-foreground/40 bg-card',
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
        'pointer-events-auto flex items-start gap-3 rounded-lg border px-3 py-2 shadow-lg',
        tone,
        className,
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconTone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-tight font-semibold">{state.title}</p>
        <p className="text-foreground/75 mt-0.5 text-xs leading-snug">{state.detail}</p>
      </div>
      {action}
      {dismissible ? (
        <button
          type="button"
          onClick={() => setDismissedKind(state.kind)}
          aria-label="Dismiss until the sky state changes"
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-foreground/10',
            '-my-1 -mr-1 shrink-0 rounded-md p-1 transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      ) : null}
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
