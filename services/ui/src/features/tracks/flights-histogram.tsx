/**
 * Flights per day, above the list, each bar a filter.
 *
 * Kibana Discover's histogram-over-results pattern. The list had no time
 * navigation at all, and "when did it happen" is the first question anyone
 * brings to a flight log — so this is the control that answers it, and the
 * window chips beside it are what bound the API query underneath.
 */
import { useMemo } from 'react'

import { cn } from '@/lib/cn'
import type { Track } from '@/lib/api/types'

import {
  bucketFlightsByDay,
  dayLabel,
  WINDOW_CHIP_LABELS,
  WINDOW_CHIPS,
  type WindowChip,
} from './flight-time'

const BAR_AREA_PX = 48

export function FlightsHistogram({
  tracks,
  utc,
  day,
  onDayChange,
  window,
  onWindowChange,
  className,
}: {
  tracks: Track[]
  utc: boolean
  day: string | undefined
  onDayChange: (day: string | undefined) => void
  window: WindowChip
  onWindowChange: (window: WindowChip) => void
  className?: string
}) {
  const { buckets, contiguous } = useMemo(() => bucketFlightsByDay(tracks, utc), [tracks, utc])
  const peak = buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0)
  const first = buckets[0]
  const last = buckets[buckets.length - 1]

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground text-2xs" id="flights-window-label">
          Window
        </span>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-labelledby="flights-window-label"
        >
          {WINDOW_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              aria-pressed={window === chip}
              onClick={() => {
                onWindowChange(chip)
                // A day outside the new window would filter everything away
                // and look like an empty database rather than a stale chip.
                onDayChange(undefined)
              }}
              className={cn(
                'rounded-md border px-2 py-0.5 text-2xs transition-colors',
                window === chip
                  ? 'border-primary/40 bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {WINDOW_CHIP_LABELS[chip]}
            </button>
          ))}
        </div>
        {day ? (
          <button
            type="button"
            onClick={() => onDayChange(undefined)}
            className="border-border text-muted-foreground hover:text-foreground ml-auto rounded-md border px-2 py-0.5 text-2xs"
          >
            Showing {day} — clear day
          </button>
        ) : null}
      </div>

      {buckets.length === 0 ? null : (
        <div className="border-border bg-card/40 rounded-lg border px-2 pt-2 pb-1">
          <div className="flex items-end gap-px" style={{ height: BAR_AREA_PX }}>
            {buckets.map((bucket) => {
              const selected = bucket.key === day
              const fraction = peak > 0 ? bucket.count / peak : 0
              return (
                <button
                  key={bucket.key}
                  type="button"
                  aria-pressed={selected}
                  // The count is in the accessible name because the bar's own
                  // height is not available to a screen reader at all.
                  aria-label={`${bucket.count} flight${bucket.count === 1 ? '' : 's'} on ${bucket.key}`}
                  title={`${dayLabel(bucket.startMs, utc)} — ${bucket.count} flight${bucket.count === 1 ? '' : 's'}`}
                  onClick={() => onDayChange(selected ? undefined : bucket.key)}
                  className="group flex h-full min-w-1 flex-1 cursor-pointer flex-col justify-end"
                >
                  <span
                    className={cn(
                      'block w-full rounded-sm transition-colors',
                      bucket.count === 0
                        ? 'bg-muted-foreground/15'
                        : selected
                          ? 'bg-primary'
                          : 'bg-track/60 group-hover:bg-track',
                    )}
                    style={{
                      // A day with flights never renders as nothing: a 1-flight
                      // bar rounded to zero pixels is indistinguishable from the
                      // empty day beside it, and those mean different things.
                      height: bucket.count === 0 ? 2 : Math.max(3, fraction * BAR_AREA_PX),
                    }}
                  />
                </button>
              )
            })}
          </div>
          <div className="text-muted-foreground mt-1 flex items-baseline justify-between text-2xs">
            <span className="tnum">{first ? dayLabel(first.startMs, utc) : null}</span>
            {!contiguous ? (
              <span>days with no flights omitted — spacing is not to scale</span>
            ) : null}
            <span className="tnum">{last ? dayLabel(last.startMs, utc) : null}</span>
          </div>
        </div>
      )}
    </div>
  )
}
