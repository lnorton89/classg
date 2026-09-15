/**
 * The expanded row: enough of the detail page to decide without opening it.
 *
 * Reviewing ten flights of the same aircraft was ten page loads, each one
 * losing the list's scroll position, filters and sort. This is the Pencil &
 * Paper expandable-row pattern — the map is the thing the page was opened for,
 * so it is the thing the row expands into.
 */
import { Link } from '@tanstack/react-router'

import { useFormat } from '@/app/use-format'
import { LiveMap } from '@/features/map/live-map'
import { plottablePoints } from '@/features/map/geo'
import type { ReceiverPosition, Track } from '@/lib/api/types'

import { EvidenceChips } from './evidence'
import {
  aircraftLabel,
  flightDurationS,
  hasOperatorFix,
  maxHeightAglM,
  maxRangeM,
} from './flight-metrics'

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-2xs">{label}</dt>
      <dd className="tnum font-mono text-xs">{value}</dd>
    </div>
  )
}

export function FlightQuickView({
  track,
  receiver,
}: {
  track: Track
  receiver: ReceiverPosition | null
}) {
  const format = useFormat()
  const duration = flightDurationS(track)
  const range = maxRangeM(track, receiver)
  const agl = maxHeightAglM(track)
  const hasLocation = plottablePoints([track]).length > 0

  return (
    <div className="flex flex-col gap-3 py-2">
      {hasLocation ? (
        // The list payload's own `history` — a ring buffer that drops the start
        // of a long flight. Good enough for a quick view; the detail page
        // rebuilds the full route from detections, which is why "Open flight"
        // is not merely a bigger version of this.
        <LiveMap
          className="h-[19rem] w-full overflow-hidden rounded-md"
          tracks={[track]}
          adsb={[]}
          selectedTrackId={track.track_id}
          coverageBroken={false}
          ariaLabel={`Flight path for ${aircraftLabel(track)}`}
          fitOnTrackChanges
          fitMaxZoom={19}
        />
      ) : (
        <p className="text-muted-foreground px-1 py-6 text-center text-xs">
          This flight recorded no position, so there is no path to draw. It was heard, not seen.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
        <Fact
          label="Window"
          value={`${format.clock(track.first_seen)} – ${format.clock(track.last_seen)}`}
        />
        <Fact label="Duration" value={duration === null ? '—' : format.duration(duration)} />
        <Fact label="Max range" value={format.range(range)} />
        <Fact label="Max height AGL" value={format.length(agl)} />
        <Fact label="Detections" value={String(track.detection_count)} />
        <Fact label="Operator" value={hasOperatorFix(track) ? 'located' : 'not located'} />
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <EvidenceChips evidence={track.evidence ?? []} />
        <Link
          to="/tracks/$trackId"
          params={{ trackId: track.track_id }}
          className="text-primary ml-auto text-xs underline-offset-2 hover:underline"
        >
          Open flight →
        </Link>
      </div>
    </div>
  )
}
