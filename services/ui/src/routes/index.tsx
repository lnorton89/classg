import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ListIcon, MapIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ContactsPanel } from '@/features/map/contacts-panel'
import { LiveMap } from '@/features/map/live-map'
import { MapLegend } from '@/features/map/legend'
import { SkyStateBanner } from '@/features/health/components'
import { computeSkyState } from '@/features/health/sky-state'
import { partitionTracks } from '@/features/tracks/partition'
import { adsbDetectionsQuery, healthQuery, tracksQuery } from '@/lib/api/queries'
import { cn } from '@/lib/cn'

export const Route = createFileRoute('/')({
  component: LiveView,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(tracksQuery()),
      context.queryClient.ensureQueryData(healthQuery()),
    ]),
})

function LiveView() {
  const { data: tracksData } = useQuery(tracksQuery())
  const { data: health } = useQuery(healthQuery())
  const { data: adsbData } = useQuery(adsbDetectionsQuery())

  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [mobilePane, setMobilePane] = useState<'map' | 'list'>('map')

  const tracks = tracksData?.tracks ?? []
  const { active: activeTracks, closed: closedTracks } = partitionTracks(tracks)
  const adsb = adsbData?.detections ?? []
  const contactCount = activeTracks.length + closedTracks.length + adsb.length
  const skyState = computeSkyState(health, activeTracks.length)

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div
        className={cn(
          'relative min-h-[55dvh] flex-1 lg:min-h-0',
          mobilePane === 'list' && 'hidden lg:block',
        )}
      >
        <LiveMap
          className="absolute inset-0"
          tracks={activeTracks}
          adsb={adsb}
          selectedTrackId={selectedTrackId}
          onSelectTrack={setSelectedTrackId}
          coverageBroken={!skyState.absenceIsEvidence}
        />

        {/*
          The banner sits over the map rather than beside it. What an empty map
          means has to be readable in the same glance as the map itself.
        */}
        <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex flex-col gap-2 sm:inset-x-3 sm:top-3">
          <SkyStateBanner state={skyState} className="max-w-2xl" />
        </div>

        <MapLegend className="absolute bottom-3 left-3 z-20 hidden sm:block" />
      </div>

      {/* Mobile: one pane at a time, switched by a toggle. */}
      <div className="border-border bg-card sticky top-14 z-30 flex gap-1 border-b p-2 lg:hidden">
        <Button
          variant={mobilePane === 'map' ? 'secondary' : 'ghost'}
          size="sm"
          className="flex-1"
          aria-pressed={mobilePane === 'map'}
          onClick={() => setMobilePane('map')}
        >
          <MapIcon aria-hidden /> Map
        </Button>
        <Button
          variant={mobilePane === 'list' ? 'secondary' : 'ghost'}
          size="sm"
          className="flex-1"
          aria-pressed={mobilePane === 'list'}
          onClick={() => setMobilePane('list')}
        >
          <ListIcon aria-hidden /> Contacts ({contactCount})
        </Button>
      </div>

      <aside
        aria-label="Contacts"
        className={cn(
          'border-border bg-card flex min-h-0 flex-col lg:w-96 lg:border-l',
          mobilePane === 'map' && 'hidden lg:flex',
        )}
      >
        <ContactsPanel
          tracks={activeTracks}
          closedTracks={closedTracks}
          adsb={adsb}
          selectedTrackId={selectedTrackId}
          onSelectTrack={setSelectedTrackId}
          className="min-h-0 flex-1"
        />
      </aside>
    </div>
  )
}
