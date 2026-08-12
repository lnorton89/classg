import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArchiveIcon, RadarIcon, RadioTowerIcon } from 'lucide-react'

import { SkyStateBanner } from '@/features/health/components'
import { computeSkyState } from '@/features/health/sky-state'
import { TrackStateKey } from '@/features/tracks/evidence'
import { partitionTracks } from '@/features/tracks/partition'
import { TracksTable } from '@/features/tracks/tracks-table'
import { healthQuery, tracksQuery } from '@/lib/api/queries'
import { PageContainer } from '@/components/layout/page-container'
import { PageHeader, SectionHeader } from '@/components/layout/page-header'

export const Route = createFileRoute('/tracks/')({
  component: TracksView,
  loader: ({ context }) => context.queryClient.ensureQueryData(tracksQuery()),
})

export function TracksView() {
  const { data } = useQuery(tracksQuery())
  const { data: health } = useQuery(healthQuery())
  const tracks = data?.tracks ?? []
  const { active: activeTracks, closed: closedTracks } = partitionTracks(tracks)
  const skyState = computeSkyState(health, activeTracks.length)

  return (
    <PageContainer>
      <PageHeader
        icon={RadarIcon}
        title="Tracks"
        description="Fusion's correlation of detections over time. A track is not a detection — identity precedence is serial, then MAC, then position and time."
      />

      <TrackStateKey />

      {/* Coverage determines whether an empty table means an empty sky. Existing
          tracks remain valid historical records even after a replay sensor exits. */}
      {activeTracks.length === 0 && !skyState.absenceIsEvidence ? (
        <SkyStateBanner state={skyState} />
      ) : null}

      <section aria-labelledby="active-tracks-heading" className="flex min-h-0 flex-col gap-2">
        <SectionHeader
          id="active-tracks-heading"
          icon={RadioTowerIcon}
          title={`Active tracks (${activeTracks.length})`}
          description="Tentative, confirmed, and coasting tracks that fusion is still monitoring."
        />
        <TracksTable
          tracks={activeTracks}
          caption="Active drone tracks, sortable by column and filterable by identity and state"
          emptyTitle="No active tracks"
        />
      </section>

      <section aria-labelledby="closed-tracks-heading" className="flex min-h-0 flex-col gap-2">
        <SectionHeader
          id="closed-tracks-heading"
          icon={ArchiveIcon}
          title={`Closed tracks (${closedTracks.length})`}
          description="Historical tracks retained after fusion stops monitoring them. Open a track to review its final route and evidence."
        />
        <TracksTable
          tracks={closedTracks}
          caption="Closed drone track history, sortable by column and filterable by identity"
          emptyTitle="No closed tracks"
          emptyDescription="Tracks appear here after their closure timeout expires."
          showStateFilter={false}
        />
      </section>
    </PageContainer>
  )
}
