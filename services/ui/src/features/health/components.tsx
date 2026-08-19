import {
  CircleCheckIcon,
  CircleSlashIcon,
  PlugZapIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DataRow } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { useSwipeDismiss } from '@/components/ui/use-swipe-dismiss'
import { useFormat, useTicker } from '@/app/use-format'
import { createDismissalStore } from '@/features/notifications/dismissal-store'
import { useDismissal } from '@/features/notifications/use-dismissal'
import type { SensorHealth } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import { formatDetailValue } from './detail-format'
import { SENSOR_ICONS } from './sensor-icons'
import type { SkyState } from './sky-state'

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

/**
 * This route's own component unmounts on every navigation away from `/`, so
 * the dismissal has to live outside it — see dismissal-store.ts for why that
 * used to make "Quiet sky" reappear.
 */
const skyStateDismissal = createDismissalStore('classg.dismissed.sky-state')

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
  const dismissible = state.absenceIsEvidence
  const [dismissedForKind, dismiss] = useDismissal(skyStateDismissal, state.kind)
  const dismissed = dismissible && dismissedForKind

  if (dismissed) return null

  // The swipe and close-animation state lives in a CHILD keyed on the kind,
  // not here. A key on a host element remounts the DOM node but NOT the hooks
  // above it, so while this component owned `closing`, a dismissed "quiet sky"
  // left it set forever and the "coverage degraded" that replaced it rendered
  // already slid off screen -- invisible, permanently, on exactly the state an
  // operator must not miss. Keying the component boundary is what actually
  // resets the hooks. The dismissal stays out here so it still survives the
  // route unmount that dismissal-store.ts exists for.
  return (
    <SkyStateBannerBody
      key={state.kind}
      state={state}
      className={className}
      action={action}
      dismissible={dismissible}
      onDismiss={dismiss}
    />
  )
}

function SkyStateBannerBody({
  state,
  className,
  action,
  dismissible,
  onDismiss,
}: {
  state: SkyState
  className?: string
  action?: ReactNode
  dismissible: boolean
  onDismiss: () => void
}) {
  const { closing, dragging, style, commit, handlers } = useSwipeDismiss({
    enabled: dismissible,
    onDismiss,
  })

  useEffect(() => {
    // This body only mounts while undismissed -- the parent gates on that --
    // so there is no already-dismissed case to skip.
    if (!dismissible) return
    const id = setTimeout(() => commit(1), QUIET_SKY_DISMISS_MS)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commit is a fresh closure every render; including it would reschedule the timer on every render rather than once per mount, and this body remounts per state kind.
  }, [dismissible])

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

  const exiting = closing !== null

  return (
    <div
      // Assertive only when the operator must not trust the screen.
      role={state.absenceIsEvidence ? 'status' : 'alert'}
      aria-live={state.absenceIsEvidence ? 'polite' : 'assertive'}
      data-sky-state={state.kind}
      data-absence-is-evidence={state.absenceIsEvidence}
      {...handlers}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-lg border px-3 py-2 shadow-lg',
        tone,
        dismissible && 'touch-pan-y',
        !dragging && 'transition-[transform,opacity] duration-200 ease-out',
        !exiting && !dragging && 'animate-in fade-in slide-in-from-top-1 duration-200',
        className,
      )}
      style={style}
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
          onClick={() => commit(1)}
          // The div's own onPointerDown calls setPointerCapture on itself for
          // the swipe gesture, and a browser retargets the click that follows
          // to whichever element holds that capture -- not to whatever was
          // actually pressed. Stopping the pointerdown here before it bubbles
          // keeps this button's own click reaching its own handler.
          onPointerDown={(event) => event.stopPropagation()}
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
