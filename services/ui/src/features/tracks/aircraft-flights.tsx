/**
 * The other flights of this airframe.
 *
 * Flightradar24's structure, inverted: there the aircraft is the page and the
 * flights are rows under it; here a flight is the page and the aircraft is a
 * block at the bottom. Either way the point is the same — identity is stated
 * once and the sessions are what differ.
 *
 * It also fixes something the detail page could not do at all. A flight
 * interrupted by a long enough reception gap closes one track and opens
 * another, so one sortie can exist as two rows; from either one, the other half
 * is simply the previous or next flight. Before this block there was no way to
 * get from one to the other except by going back to the list and finding it.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronLeftIcon, ChevronRightIcon, PlaneIcon } from 'lucide-react'

import { useFormat } from '@/app/use-format'
import { buttonVariants } from '@/components/ui/button-variants'
import { dayLabel } from '@/features/tracks/flight-time'
import { tracksQuery } from '@/lib/api/queries'
import type { ReceiverPosition, Track } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import {
  flightDurationS,
  flightNeighbours,
  flightRangeMs,
  flightStartMs,
  flightsAround,
  orderFlights,
} from './flight-metrics'
import { PathThumbnail } from './path-thumbnail'

/**
 * Well past any airframe's real flight count on a 30-day retention window, and
 * small enough that the response stays one page. A serial with more than this
 * is a unit that has been watching one aircraft for months; "All N" opens the
 * filtered list, which pages properly.
 */
const MAX_FLIGHTS = 1000

/** Thumbnails shown in the strip. Past this the strip scrolls rather than wraps. */
const MAX_THUMBNAILS = 12

export function AircraftFlights({
  serial,
  trackId,
  receiver,
}: {
  serial: string
  trackId: string
  receiver: ReceiverPosition | null
}) {
  const format = useFormat()
  // Server-side `serial` filtering is the phase 2 API addition; without it this
  // block would have to page the whole closed history and filter client-side.
  const { data } = useQuery(tracksQuery({ serial, limit: MAX_FLIGHTS }))
  const flights = orderFlights(data?.tracks ?? [])
  const { number, total, previous, next } = flightNeighbours(flights, trackId)
  const range = flightRangeMs(flights)
  const strip = flightsAround(flights, trackId, MAX_THUMBNAILS)

  if (total === 0) return null

  return (
    <section aria-labelledby="this-aircraft-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          id="this-aircraft-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <PlaneIcon className="text-muted-foreground size-4" aria-hidden />
          This aircraft
        </h2>
        <p className="text-muted-foreground text-xs">
          {total} {total === 1 ? 'flight' : 'flights'}
          {range
            ? ` · ${dayLabel(range.startMs, format.zoneLabel === 'UTC')} – ${dayLabel(range.endMs, format.zoneLabel === 'UTC')}`
            : ''}
          {number !== null ? ` · this is flight ${number} of ${total}` : ''}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FlightStep to={previous} direction="previous" />
        <FlightStep to={next} direction="next" />
        <Link
          to="/tracks"
          search={{ q: serial }}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs')}
        >
          All {total}
        </Link>
      </div>

      {/* Shapes, because a shape is what makes a list of near-identical
          flights scannable at all -- the same argument as the list's own
          thumbnail column, at the same size and from the same projection. */}
      <ul className="flex flex-nowrap gap-2 overflow-x-auto pb-1 [scrollbar-gutter:stable]">
        {strip.items.map((flight) => {
          const startMs = flightStartMs(flight)
          const duration = flightDurationS(flight)
          const current = flight.track_id === trackId
          return (
            <li key={flight.track_id} className="shrink-0">
              <Link
                to="/tracks/$trackId"
                params={{ trackId: flight.track_id }}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'hover:bg-accent/40 flex flex-col items-start gap-1 rounded-md border p-1.5',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                  current ? 'border-track bg-accent/30' : 'border-border',
                )}
              >
                <PathThumbnail track={flight} receiver={receiver} />
                <span className="text-muted-foreground tnum font-mono text-2xs">
                  {startMs === null ? '—' : format.clockBrief(new Date(startMs).toISOString())}
                  {duration === null ? '' : ` · ${format.duration(duration)}`}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      {flights.length > MAX_THUMBNAILS ? (
        <p className="text-muted-foreground text-2xs">
          Showing flights {strip.from + 1}–{strip.from + strip.items.length} of {flights.length}
          . “All {total}” opens the full list.
        </p>
      ) : null}
    </section>
  )
}

function FlightStep({ to, direction }: { to: Track | null; direction: 'previous' | 'next' }) {
  const label = direction === 'previous' ? 'Previous flight' : 'Next flight'
  const Icon = direction === 'previous' ? ChevronLeftIcon : ChevronRightIcon
  const classes = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-xs')

  if (!to) {
    // Rendered disabled rather than omitted: a button that vanishes at the
    // ends of the list moves the one beside it under the cursor.
    return (
      <span className={cn(classes, 'pointer-events-none opacity-40')} aria-disabled>
        {direction === 'previous' ? <Icon aria-hidden /> : null}
        {label}
        {direction === 'next' ? <Icon aria-hidden /> : null}
      </span>
    )
  }
  return (
    <Link to="/tracks/$trackId" params={{ trackId: to.track_id }} className={classes}>
      {direction === 'previous' ? <Icon aria-hidden /> : null}
      {label}
      {direction === 'next' ? <Icon aria-hidden /> : null}
    </Link>
  )
}
