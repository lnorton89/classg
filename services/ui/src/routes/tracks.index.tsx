import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { SkyStateBanner } from '@/features/health/components'
import { computeSkyState } from '@/features/health/sky-state'
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
  const skyState = computeSkyState(health, tracks.length)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Tracks</h1>
        <p className="text-muted-foreground text-xs">
          Fusion&apos;s correlation of detections over time. A track is not a detection —
          identity precedence is serial, then MAC, then position and time.
        </p>
      </div>

      {/* Repeated here deliberately: a table of zero rows raises the same "is it
          broken or is it quiet" question the map does. */}
      {skyState.absenceIsEvidence ? null : <SkyStateBanner state={skyState} />}

      <TracksTable tracks={tracks} />
    </div>
  )
}
