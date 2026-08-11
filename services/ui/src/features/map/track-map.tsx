import { UserIcon } from 'lucide-react'

import type { Track } from '@/lib/api/types'

import { plottablePoints } from './geo'
import { LiveMap } from './live-map'

export function TrackMap({ track }: { track: Track }) {
  const historyCount = track.history?.length ?? 0
  const hasLocation = plottablePoints([track]).length > 0

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
        tracks={[track]}
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
