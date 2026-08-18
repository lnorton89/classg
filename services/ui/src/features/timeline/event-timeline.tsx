/**
 * The band of time, drawn.
 *
 * Hand-rolled SVG on the RssiChart / SpectrumChart precedent: a charting
 * library would be the largest thing in a bundle served by a Pi over its own
 * access point.
 *
 * One rule shapes it. **A bar is presence, not certainty.** It spans the
 * evidence — first_seen to last_seen — and stops there. An open track whose
 * sensor has been quiet for ten minutes does not get a bar stretched to the
 * present, because that would draw an aircraft still overhead when what we
 * actually know is that we stopped hearing it.
 */
import { useState } from 'react'

import { cn } from '@/lib/cn'
import type { Track } from '@/lib/api/types'

import { fractionAt, laneCount, ticks, timeAt } from './lanes'
import type { TimelineEvent, TimelineWindow } from './lanes'

const LANE_H = 18
const LANE_GAP = 4
const PAD_TOP = 6

export interface EventTimelineProps {
  events: TimelineEvent[]
  window: TimelineWindow
  onSelect: (track: Track) => void
  selectedId: string | null
  formatTime: (iso: string) => string
}

export function EventTimeline({
  events,
  window,
  onSelect,
  selectedId,
  formatTime,
}: EventTimelineProps) {
  const [hoverMs, setHoverMs] = useState<number | null>(null)

  const lanes = Math.max(1, laneCount(events))
  const height = PAD_TOP * 2 + lanes * LANE_H + (lanes - 1) * LANE_GAP

  const x = (ms: number) => fractionAt(window, ms) * 100
  const laneY = (lane: number) => PAD_TOP + lane * (LANE_H + LANE_GAP)

  const hoverLabel = hoverMs === null ? null : formatTime(new Date(hoverMs).toISOString())

  return (
    <div>
      <div
        className="relative touch-none"
        style={{ height }}
        onPointerLeave={() => setHoverMs(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (rect.width <= 0) return
          setHoverMs(timeAt(window, (event.clientX - rect.left) / rect.width))
        }}
      >
        {/* Gridlines and the now marker are absolutely positioned percentages
            rather than SVG, so a bar can be a real <button>: keyboard focus,
            a tooltip, and an accessible name come free, and an operator
            tabbing through events is the review workflow this page is for. */}
        <div className="border-border/60 bg-muted/20 absolute inset-0 rounded-md border" />

        {ticks(window).map((t) => (
          <div
            key={t}
            aria-hidden
            className="bg-border/60 absolute top-0 bottom-0 w-px"
            style={{ left: `${x(t)}%` }}
          />
        ))}

        {hoverMs !== null ? (
          <div
            aria-hidden
            className="bg-foreground/30 absolute top-0 bottom-0 w-px"
            style={{ left: `${x(hoverMs)}%` }}
          />
        ) : null}

        {events.map((event) => (
          <EventBar
            key={event.track.track_id}
            event={event}
            left={x(event.fromMs)}
            width={Math.max(0.4, x(event.toMs) - x(event.fromMs))}
            top={laneY(event.lane)}
            selected={event.track.track_id === selectedId}
            onSelect={() => onSelect(event.track)}
            formatTime={formatTime}
          />
        ))}
      </div>

      <div className="text-muted-foreground tnum relative mt-1 h-4 text-2xs">
        {ticks(window).map((t) => (
          <span
            key={t}
            className="absolute -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${x(t)}%` }}
          >
            {formatTime(new Date(t).toISOString())}
          </span>
        ))}
      </div>

      <p className="text-muted-foreground tnum mt-1 h-4 font-mono text-2xs" aria-live="off">
        {hoverLabel ?? ''}
      </p>
    </div>
  )
}

function EventBar({
  event,
  left,
  width,
  top,
  selected,
  onSelect,
  formatTime,
}: {
  event: TimelineEvent
  left: number
  width: number
  top: number
  selected: boolean
  onSelect: () => void
  formatTime: (iso: string) => string
}) {
  const { track } = event
  const label = [
    trackLabel(track) === '' ? track.track_id : trackLabel(track),
    track.state.toLowerCase(),
    `${formatTime(track.first_seen)} to ${formatTime(track.last_seen)}`,
    event.clippedStart || event.clippedEnd ? 'extends beyond this window' : '',
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      title={label}
      className={cn(
        'absolute overflow-hidden rounded-sm border text-left',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        stateClass(track.state),
        selected && 'ring-primary ring-2',
        // A bar cut off by the window edge is squared rather than rounded on
        // that side, so "this continues past here" is visible without reading
        // the tooltip.
        event.clippedStart && 'rounded-l-none border-l-0',
        event.clippedEnd && 'rounded-r-none border-r-0',
      )}
      style={{ left: `${left}%`, width: `${width}%`, top, height: LANE_H }}
    >
      <span className="truncate px-1 text-[10px] leading-[18px] font-medium">
        {width > 6 ? trackLabel(track) : ''}
      </span>
    </button>
  )
}

/** Serial first, then a MAC. Identity is optional on a track that has only
 * been seen by RF envelope, in which case the bar carries no text and the
 * tooltip falls back to the track id. */
function trackLabel(track: Track): string {
  // `??` is wrong here: an identity that arrived with an empty serial must
  // fall through to the MAC, and an empty string is not nullish.
  const serial = track.identity?.serial ?? ''
  if (serial !== '') return serial
  return track.identity?.macs?.[0] ?? ''
}

/**
 * Colour follows the track state badge, so a bar and a row in the table below
 * it never disagree about what a track is.
 */
function stateClass(state: string): string {
  switch (state) {
    case 'CONFIRMED':
      return 'bg-ok/25 border-ok/60 hover:bg-ok/40'
    case 'COASTING':
      return 'bg-warn/25 border-warn/60 hover:bg-warn/40'
    case 'CLOSED':
      return 'bg-muted-foreground/20 border-muted-foreground/40 hover:bg-muted-foreground/30'
    default:
      return 'bg-primary/20 border-primary/50 hover:bg-primary/35'
  }
}
