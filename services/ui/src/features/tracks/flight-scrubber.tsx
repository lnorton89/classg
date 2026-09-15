/**
 * Play a recorded flight back.
 *
 * A polyline of a route that crosses itself is unreadable: you cannot tell the
 * outbound leg from the return, and the loop over the far corner could have
 * happened first or last. Both Dedrone and AeroScope solve it the same way and
 * so does this — a transport under the map, and a marker that moves.
 *
 * The rail is a real `<input type="range">` rather than a div with a drag
 * handler. It costs nothing and it arrives keyboard-operable, with arrow keys,
 * Home and End, and an announced value — which a hand-rolled track would have
 * had to reimplement and, going by every other implementation of this control
 * on the web, would not have.
 */
import { PauseIcon, PlayIcon, SkipBackIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { useFormat } from '@/app/use-format'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'

import { PLAYBACK_RATES, type PlaybackRate, type PlaybackSpan } from './flight-playback'

/**
 * 10 Hz. Smooth enough to read as motion, and deliberately not 60: each tick
 * re-renders the page's cursor, its three profile lanes and a MapLibre marker,
 * on a tab this box serves over its own Wi-Fi AP.
 */
const TICK_MS = 100

export function FlightScrubber({
  span,
  atMs,
  onScrub,
  playing,
  onPlayingChange,
  rate,
  onRateChange,
  /** Said aloud beside the clock when the replay is inside a reception gap. */
  heard = true,
  className,
}: {
  span: PlaybackSpan
  atMs: number
  onScrub: (ms: number) => void
  playing: boolean
  onPlayingChange: (playing: boolean) => void
  rate: PlaybackRate
  onRateChange: (rate: PlaybackRate) => void
  heard?: boolean
  className?: string
}) {
  const format = useFormat()
  const totalMs = span.endMs - span.startMs
  const elapsedMs = Math.min(totalMs, Math.max(0, atMs - span.startMs))

  // Refs, not dependencies: re-creating the interval on every tick would reset
  // its phase 20 times a second and the playhead would crawl. Synced in an
  // effect rather than in the render body, which is a write during render and
  // therefore a tear under concurrent rendering.
  const atRef = useRef(atMs)
  const rateRef = useRef(rate)
  const onScrubRef = useRef(onScrub)
  const onPlayingRef = useRef(onPlayingChange)

  useEffect(() => {
    atRef.current = atMs
    rateRef.current = rate
    onScrubRef.current = onScrub
    onPlayingRef.current = onPlayingChange
  })

  useEffect(() => {
    if (!playing || totalMs <= 0) return
    const id = setInterval(() => {
      const next = atRef.current + TICK_MS * rateRef.current
      if (next >= span.endMs) {
        onScrubRef.current(span.endMs)
        // Stops at the end rather than looping. A replay that restarts on its
        // own is indistinguishable from a live feed at a glance, which on this
        // console is the one thing a past-tense view must never look like.
        onPlayingRef.current(false)
        return
      }
      onScrubRef.current(next)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [playing, span.endMs, totalMs])

  const disabled = totalMs <= 0

  return (
    <div className={cn('border-border flex flex-col gap-2 border-t px-3 py-2.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label={playing ? 'Pause replay' : 'Play replay'}
          disabled={disabled}
          onClick={() => {
            // Pressing play at the end restarts rather than doing nothing.
            if (!playing && atMs >= span.endMs) onScrub(span.startMs)
            onPlayingChange(!playing)
          }}
        >
          {playing ? (
            <PauseIcon className="size-4" aria-hidden />
          ) : (
            <PlayIcon className="size-4" aria-hidden />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to the start of the flight"
          disabled={disabled}
          onClick={() => {
            onScrub(span.startMs)
          }}
        >
          <SkipBackIcon className="size-4" aria-hidden />
        </Button>

        <input
          type="range"
          min={span.startMs}
          max={span.endMs}
          step={Math.max(1, Math.round(totalMs / 1000))}
          value={atMs}
          disabled={disabled}
          aria-label="Flight replay position"
          aria-valuetext={`${format.clock(new Date(atMs).toISOString())}, ${formatDuration(
            elapsedMs / 1000,
          )} of ${formatDuration(totalMs / 1000)}`}
          onChange={(event) => {
            onPlayingChange(false)
            onScrub(Number(event.target.value))
          }}
          className="accent-track h-1.5 min-w-40 flex-1 cursor-pointer"
        />

        <div className="flex items-center gap-1" role="group" aria-label="Replay speed">
          {PLAYBACK_RATES.map((option) => (
            <Button
              key={option}
              variant={option === rate ? 'default' : 'ghost'}
              size="sm"
              aria-pressed={option === rate}
              disabled={disabled}
              className="tnum px-2 font-mono text-2xs"
              onClick={() => {
                onRateChange(option)
              }}
            >
              {option}×
            </Button>
          ))}
        </div>
      </div>

      <p className="text-muted-foreground tnum flex flex-wrap items-baseline gap-x-3 text-2xs">
        <span className="text-foreground font-mono">
          {format.clock(new Date(atMs).toISOString())}
        </span>
        <span>
          {formatDuration(elapsedMs / 1000)} of {formatDuration(totalMs / 1000)}
        </span>
        {/* The scrubber's clock keeps running through a reception gap because
            the clock is real; the marker under it is parked on the last fix.
            Saying so is the difference between a paused marker and a marker
            that is lying about where the aircraft was. */}
        {!heard ? <span className="text-warn">not heard — marker held at last fix</span> : null}
      </p>
    </div>
  )
}
