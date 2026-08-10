import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { SkyStateBanner } from '@/features/health/components'
import { computeSkyState } from '@/features/health/sky-state'
import { TrackStateKey } from '@/features/tracks/evidence'
import { partitionTracks } from '@/features/tracks/partition'
import { TracksTable } from '@/features/tracks/tracks-table'
import { healthQuery, tracksQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/tracks/')({
  component: TracksView,
  loader: ({ context }) => context.queryClient.ensureQueryData(tracksQuery()),
})

function TracksView() {
  const { data } = useQuery(tracksQuery())
  const { data: health } = useQuery(healthQuery())
  const tracks = data?.tracks ?? []
  const { active: activeTracks, closed: closedTracks } = partitionTracks(tracks)
  const skyState = computeSkyState(health, activeTracks.length)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Tracks</h1>
        <p className="text-muted-foreground text-xs">
          Fusion&apos;s correlation of detections over time. A track is not a detection —
          identity precedence is serial, then MAC, then position and time.
        </p>
      </div>

      <TrackStateKey />

      {/* Coverage determines whether an empty table means an empty sky. Existing
          tracks remain valid historical records even after a replay sensor exits. */}
      {activeTracks.length === 0 && !skyState.absenceIsEvidence ? (
        <SkyStateBanner state={skyState} />
      ) : null}

      <section aria-labelledby="active-tracks-heading" className="flex min-h-0 flex-col gap-2">
        <div>
          <h2 id="active-tracks-heading" className="text-sm font-semibold">
            Active tracks ({activeTracks.length})
          </h2>
          <p className="text-muted-foreground text-xs">
            Tentative, confirmed, and coasting tracks that fusion is still monitoring.
          </p>
        </div>
        <TracksTable
          tracks={activeTracks}
          caption="Active drone tracks, sortable by column and filterable by identity and state"
          emptyTitle="No active tracks"
        />
      </section>

      <section aria-labelledby="closed-tracks-heading" className="flex min-h-0 flex-col gap-2">
        <div>
          <h2 id="closed-tracks-heading" className="text-sm font-semibold">
            Closed tracks ({closedTracks.length})
          </h2>
          <p className="text-muted-foreground text-xs">
            Historical tracks retained after fusion stops monitoring them. Open a track to
            review its final route and evidence.
          </p>
        </div>
        <TracksTable
          tracks={closedTracks}
          caption="Closed drone track history, sortable by column and filterable by identity"
          emptyTitle="No closed tracks"
          emptyDescription="Tracks appear here after their closure timeout expires."
          showStateFilter={false}
        />
      </section>
    </div>
  )
}
