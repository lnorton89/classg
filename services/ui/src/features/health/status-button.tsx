/**
 * The header's one status surface.
 *
 * It replaced four: a system-health badge, a stream badge, a recording
 * indicator and a sensor count, each of which insisted it must always be
 * visible. All four were right about that in isolation and wrong together --
 * on a phone they left the logo clipped and none of them legible.
 *
 * The button shows the single most alarming true thing (status-summary.ts
 * decides which, and unit tests pin the ordering). Everything the four badges
 * used to say is one tap away, laid out with room to explain itself rather
 * than compressed into a coloured dot.
 *
 * The one rule that survived intact: a system that is not recording must never
 * look like a system that is. "Paused" reaches the button face at every width,
 * ahead of a degraded sensor, because it is the failure with no other symptom.
 */
import { useQuery } from '@tanstack/react-query'
import { ActivityIcon, CircleCheckIcon, RadioIcon, TriangleAlertIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { useFormat, useTicker } from '@/app/use-format'
import { useLive } from '@/app/live-context'
import { Popover } from '@/components/ui/popover'
import { RecordingIndicator } from '@/features/monitoring/recording-indicator'
import { healthQuery, monitoringQuery } from '@/lib/api/queries'
import { cn } from '@/lib/cn'

import { summariseStatus, type StatusTone } from './status-summary'

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'border-ok/35 bg-ok/10 text-ok hover:bg-ok/20',
  warn: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
  down: 'border-down/45 bg-down/10 text-down hover:bg-down/20',
  unknown: 'border-border bg-muted/40 text-muted-foreground hover:bg-muted',
}

const TONE_DOT: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  down: 'bg-down',
  unknown: 'bg-muted-foreground',
}

export function StatusButton() {
  const [open, setOpen] = useState(false)
  const health = useQuery(healthQuery())
  const monitoring = useQuery(monitoringQuery())
  const { connection } = useLive()

  const status = summariseStatus({
    health: health.data,
    monitoring: monitoring.data,
    connection,
    healthError: health.isError,
  })

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      aria-label="System status"
      align="end"
      trigger={
        <button
          type="button"
          aria-label={`System status: ${status.detail} Open the status panel.`}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-full border pr-2.5 pl-2',
            'text-xs font-medium transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            TONE_CLASS[status.tone],
          )}
        >
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              TONE_DOT[status.tone],
              // Only when something is wrong. A pulsing dot on a healthy unit
              // is an alarm that is always on, which is an alarm nobody reads.
              status.tone !== 'ok' && status.tone !== 'unknown' && 'animate-pulse',
            )}
            aria-hidden
          />
          {/* The label is never hidden by width. A dot alone means the
              operator has to tap to find out whether the box is recording,
              which is the one thing that must not take a tap. */}
          <span className="whitespace-nowrap">{status.label}</span>
        </button>
      }
    >
      <StatusPanel onNavigate={() => setOpen(false)} />
    </Popover>
  )
}

function StatusPanel({ onNavigate }: { onNavigate: () => void }) {
  const health = useQuery(healthQuery())
  const monitoring = useQuery(monitoringQuery())
  const { connection, lastFrameAt, reconnectAttempt } = useLive()
  const format = useFormat()
  // The stream row shows "last frame 3s ago", which is worthless if it does
  // not move.
  useTicker(1000)

  const status = summariseStatus({
    health: health.data,
    monitoring: monitoring.data,
    connection,
    healthError: health.isError,
  })

  const sensors = health.data?.sensors ?? []
  const unhealthy = sensors.filter((s) => !s.healthy)

  const stream = {
    open: { tone: 'ok' as const, label: 'Connected' },
    connecting: { tone: 'unknown' as const, label: 'Connecting…' },
    reconnecting: {
      tone: 'warn' as const,
      label: `Reconnecting (attempt ${reconnectAttempt})`,
    },
    closed: { tone: 'down' as const, label: 'Disconnected' },
  }[connection]

  return (
    <div className="divide-border/60 divide-y">
      <p className="px-3 py-2.5 text-xs leading-relaxed">{status.detail}</p>

      {/* Recording keeps its own control rather than a link to one. It is the
          only thing in this panel an operator changes from the header. */}
      <Row icon={RadioIcon} label="Recording">
        <RecordingIndicator />
      </Row>

      <Row icon={ActivityIcon} label="Live stream">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Dot tone={stream.tone} />
          <span className="text-xs">{stream.label}</span>
          {connection === 'open' ? (
            <span className="text-muted-foreground text-2xs">
              last frame{' '}
              {format.relative(lastFrameAt ? new Date(lastFrameAt).toISOString() : null)}
            </span>
          ) : (
            <span className="text-muted-foreground text-2xs">
              positions on screen may be stale
            </span>
          )}
        </div>
      </Row>

      <Row
        icon={unhealthy.length > 0 ? TriangleAlertIcon : CircleCheckIcon}
        label={`Sensors (${sensors.length - unhealthy.length}/${sensors.length})`}
      >
        {health.isError ? (
          <p className="text-down text-xs">The API is unreachable.</p>
        ) : sensors.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            None registered — nothing on screen is evidence of anything.
          </p>
        ) : (
          <ul className="space-y-1">
            {sensors.map((s) => (
              <li key={s.sensor_id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <Dot tone={s.healthy ? 'ok' : 'down'} />
                <span className="font-mono text-2xs">{s.sensor_id}</span>
                {/* A degraded sensor without a reason sends an operator to the
                    wrong place (ADR-0003). */}
                {!s.healthy && s.reason ? (
                  <span className="text-down text-2xs">{s.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Row>

      <div className="px-3 py-2">
        <Link
          to="/sensors"
          onClick={onNavigate}
          className="text-primary text-xs font-medium hover:underline"
        >
          Sensor detail and controls →
        </Link>
      </div>
    </div>
  )
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="px-3 py-2.5">
      <p className="text-muted-foreground label-caps mb-1.5 flex items-center gap-1.5">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </p>
      {children}
    </div>
  )
}

function Dot({ tone }: { tone: StatusTone }) {
  return <span className={cn('inline-block size-2 rounded-full', TONE_DOT[tone])} aria-hidden />
}
