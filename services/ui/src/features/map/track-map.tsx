import { UserIcon } from 'lucide-react'

import type { Position, Track } from '@/lib/api/types'

import { plottablePoints } from './geo'
import { LiveMap } from './live-map'

/**
 * `path` overrides the track's own history for drawing.
 *
 * The detail page rebuilds the route from detections, because a track's history
 * is a ring buffer that drops its start on a long flight. Substituting it into
 * the track handed to LiveMap keeps the map itself unaware of where a path came
 * from -- it draws `history`, as it does for a live aircraft.
 */
export function TrackMap({ track, path }: { track: Track; path?: Position[] }) {
  const plotted =
    path && path.length > (track.history?.length ?? 0) ? { ...track, history: path } : track
  const historyCount = plotted.history?.length ?? 0
  const hasLocation = plottablePoints([plotted]).length > 0

  if (!hasLocation) {
    return (
      <div className="text-muted-foreground flex h-48 items-center justify-center px-6 text-center text-xs">
        No aircraft, path, or operator coordinates are available for this track.
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden">
      <LiveMap
        className="h-[22rem] min-h-72 w-full sm:h-[26rem]"
        tracks={[plotted]}
        adsb={[]}
        selectedTrackId={track.track_id}
        coverageBroken={false}
        ariaLabel={`Flight path map for ${track.identity?.serial ?? track.track_id}`}
        fitOnTrackChanges
        fitMaxZoom={19}
      />

      <div className="bg-card/90 border-border pointer-events-none absolute top-3 left-3 z-20 rounded-md border px-2.5 py-2 text-2xs shadow-sm backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="bg-track block h-0.5 w-6 rounded" aria-hidden />
          <span>Drone path ({historyCount} points)</span>
        </div>
        {track.operator ? (
          <div className="mt-1.5 flex items-center gap-2 text-operator">
            <UserIcon className="size-3.5" aria-hidden />
            <span>Operator position</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
