import { UserIcon } from 'lucide-react'

import { useFormat } from '@/app/use-format'
import type { Position, Track } from '@/lib/api/types'
import { formatDuration } from '@/lib/format'

import { plottablePoints, trailGaps } from './geo'
import { LiveMap } from './live-map'
import { rampMixExpressions, type ColouredPath, type PathColourMode } from './path-colour'

/**
 * `path` overrides the track's own history for drawing.
 *
 * The detail page rebuilds the route from detections, because a track's history
 * is a ring buffer that drops its start on a long flight. Substituting it into
 * the track handed to LiveMap keeps the map itself unaware of where a path came
 * from -- it draws `history`, as it does for a live aircraft.
 */
export function TrackMap({
  track,
  path,
  colouredPath = null,
  colourMode = 'none',
  cursor = null,
}: {
  track: Track
  path?: Position[]
  /** The shaded route. Only the detail page passes one -- see path-colour.ts. */
  colouredPath?: ColouredPath | null
  colourMode?: PathColourMode
  cursor?: { lat: number; lon: number; label: string } | null
}) {
  const plotted =
    path && path.length > (track.history?.length ?? 0) ? { ...track, history: path } : track
  const historyCount = plotted.history?.length ?? 0
  const hasLocation = plottablePoints([plotted]).length > 0
  // Named in the legend rather than left to the dashes alone: an operator
  // reading "7m42s" knows the loop is missing because the aircraft was out of
  // range, not because the map dropped it.
  const gaps = trailGaps(plotted.history ?? [])
  const longestGap = gaps.reduce((max, g) => Math.max(max, g.seconds), 0)
  const dwellCount = colouredPath?.dwells.features.length ?? 0

  if (!hasLocation) {
    return (
      // The same heights as the map below, not a shorter box. Whether a flight
      // has a path is not known until its detections have loaded, so a 12rem
      // placeholder that becomes a 32rem map moves everything under it -- the
      // profiles, the identity card -- the moment the data lands, which reads
      // as the page redrawing itself rather than as a page that finished.
      <div className="text-muted-foreground bg-muted/20 border-border flex h-[22rem] min-h-72 items-center justify-center rounded-lg border border-dashed px-6 text-center text-xs sm:h-[26rem] lg:h-[32rem]">
        No aircraft, path, or operator coordinates are available for this track.
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden">
      <LiveMap
        className="h-[22rem] min-h-72 w-full sm:h-[26rem] lg:h-[32rem]"
        tracks={[plotted]}
        adsb={[]}
        selectedTrackId={track.track_id}
        coverageBroken={false}
        ariaLabel={`Flight path map for ${track.identity?.serial ?? track.track_id}`}
        fitOnTrackChanges
        fitMaxZoom={19}
        colouredPath={colouredPath}
        cursor={cursor}
      />

      <div className="bg-card/90 border-border pointer-events-none absolute top-3 left-3 z-20 max-w-[min(18rem,calc(100%-1.5rem))] rounded-md border px-2.5 py-2 text-2xs shadow-sm backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="bg-track block h-0.5 w-6 rounded" aria-hidden />
          <span>Drone path ({historyCount} points)</span>
        </div>

        {colouredPath && colourMode === 'speed' ? (
          <SpeedLegend coloured={colouredPath} dwellCount={dwellCount} />
        ) : null}

        {gaps.length > 0 ? (
          <div className="mt-1.5 flex items-center gap-2">
            <span
              className="border-track block w-6 border-t border-dashed opacity-70"
              aria-hidden
            />
            <span>
              Not heard for {formatDuration(longestGap)}
              {gaps.length > 1 ? ` (${gaps.length} gaps)` : ''}
            </span>
          </div>
        ) : null}
        {track.operator ? (
          <div className="text-operator mt-1.5 flex items-center gap-2">
            <UserIcon className="size-3.5" aria-hidden />
            <span>Operator position</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The scale for the speed ramp.
 *
 * A sequential ramp without its numbers is decoration: the reader can see that
 * one leg was faster than another and cannot say by how much, which on a page
 * whose whole job is "what did this aircraft do" is most of the answer missing.
 * The swatch is built from the same `color-mix` steps the map paints with, so
 * the legend cannot drift from the canvas when a token is retuned.
 */
function SpeedLegend({ coloured, dwellCount }: { coloured: ColouredPath; dwellCount: number }) {
  const format = useFormat()
  const extent = coloured.extent

  if (!extent) {
    return (
      <p className="text-muted-foreground mt-1.5">No point in this flight reported a speed.</p>
    )
  }

  const steps = rampMixExpressions('var(--track-dim)', 'var(--track)')

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="border-border block h-2 w-16 rounded-sm border"
          style={{ background: `linear-gradient(to right, ${steps.join(', ')})` }}
        />
        <span className="tnum font-mono">
          {format.speed(extent.min)} – {format.speed(extent.max)}
        </span>
      </div>
      {coloured.unknownSegments > 0 ? (
        <div className="flex items-center gap-2">
          <span className="bg-muted-foreground block h-0.5 w-6 rounded" aria-hidden />
          <span>{coloured.unknownSegments} segments with no reported speed</span>
        </div>
      ) : null}
      {dwellCount > 0 ? (
        <div className="flex items-center gap-2">
          <span
            className="border-track block size-2.5 rounded-full border-2 opacity-90"
            aria-hidden
          />
          <span>
            {dwellCount} {dwellCount === 1 ? 'hover' : 'hovers'} — sized by how long
          </span>
        </div>
      ) : null}
    </div>
  )
}
