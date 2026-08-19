import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArchiveIcon, RadarIcon, RadioTowerIcon } from 'lucide-react'
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { TrackStateKey } from '@/features/tracks/evidence'
import { partitionTracks } from '@/features/tracks/partition'
import { TracksTable } from '@/features/tracks/tracks-table'
import { closedTracksHistoryQuery, tracksQuery } from '@/lib/api/queries'
import type { Track } from '@/lib/api/types'
import { PageContainer } from '@/components/layout/page-container'
import { PageHeader, SectionHeader } from '@/components/layout/page-header'

export const Route = createFileRoute('/tracks/')({
  component: TracksView,
  loader: ({ context }) => context.queryClient.ensureQueryData(tracksQuery()),
})

function TracksView() {
  const { data } = useQuery(tracksQuery())
  const tracks = data?.tracks ?? []
  const { active: activeTracks, closed: liveClosed } = partitionTracks(tracks)

  // The live list holds one server page, so on a unit with weeks of history it
  // silently ended at whatever the API's page size is. History is paged on the
  // cursor instead, with the tracks the socket closed this session merged over
  // it -- they are fresher than any fetched page.
  const history = useInfiniteQuery(closedTracksHistoryQuery())
  const closedTracks = useMemo(() => {
    const byId = new Map<string, Track>()
    for (const page of history.data?.pages ?? []) {
      for (const track of page.tracks) byId.set(track.track_id, track)
    }
    for (const track of liveClosed) byId.set(track.track_id, track)
    return [...byId.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))
  }, [history.data, liveClosed])
  // The last page's total is the server's current count of everything closed,
  // which is what makes "N of M" honest when M is bigger than what is loaded.
  const closedTotal = history.data?.pages.at(-1)?.total

  return (
    <PageContainer>
      <PageHeader
        icon={RadarIcon}
        title="Tracks"
        description="Fusion's correlation of detections over time. A track is not a detection — identity precedence is serial, then MAC, then position and time."
      />

      <TrackStateKey />

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
          excludeStates={['CLOSED']}
        />
      </section>

      <section aria-labelledby="closed-tracks-heading" className="flex min-h-0 flex-col gap-2">
        <SectionHeader
          id="closed-tracks-heading"
          icon={ArchiveIcon}
          title={
            closedTotal !== undefined && closedTotal > closedTracks.length
              ? `Closed tracks (${closedTracks.length} of ${closedTotal})`
              : `Closed tracks (${closedTracks.length})`
          }
          description="Historical tracks retained after fusion stops monitoring them. Open a track to review its final route and evidence."
        />
        <TracksTable
          tracks={closedTracks}
          caption="Closed drone track history, sortable by column and filterable by identity"
          emptyTitle="No closed tracks"
          emptyDescription="Tracks appear here after their closure timeout expires."
          showStateFilter={false}
        />
        {history.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage
              ? 'Loading…'
              : closedTotal !== undefined
                ? `Load more (${closedTotal - closedTracks.length} older)`
                : 'Load more'}
          </Button>
        ) : null}
      </section>
    </PageContainer>
  )
}
