import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ListIcon,
  MapIcon,
  MapPinOffIcon,
  PlaneIcon,
  RadarIcon,
  SatelliteDishIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { Button } from '@/components/ui/button'
import { StatTile } from '@/components/ui/stat'
import { aircraftFromDetections } from '@/features/map/aircraft'
import { ContactsPanel } from '@/features/map/contacts-panel'
import { LiveMap } from '@/features/map/live-map'
import { MapLegend } from '@/features/map/legend'
import { useContactSelection } from '@/features/map/selection'
import { SkyStateBanner } from '@/features/health/components'
import { computeSkyState } from '@/features/health/sky-state'
import { partitionTracks } from '@/features/tracks/partition'
import {
  ADSB_WINDOW_MS,
  adsbDetectionsQuery,
  healthQuery,
  tracksQuery,
} from '@/lib/api/queries'
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
  const { preferences } = usePreferences()

  // One selection for the whole view — drone or manned, never both. See
  // features/map/selection.ts for why that exclusion is structural.
  const { selectedTrackId, selectedMannedIcao, selectTrack, selectManned } =
    useContactSelection()

  const [mobilePane, setMobilePane] = useState<'map' | 'list'>('map')

  const tracks = tracksData?.tracks ?? []
  const {
    active: activeTracks,
    unidentified: unidentifiedTracks,
    closed: closedTracks,
  } = partitionTracks(tracks)
  // One entry per aircraft, not per report. The feed is a stream of SBS
  // messages, so an airliner overhead arrives dozens of times and the panel
  // counted every one of them as a separate contact.
  const adsb = useMemo(
    () => aircraftFromDetections(adsbData?.detections ?? [], ADSB_WINDOW_MS),
    [adsbData],
  )
  const showClosed = preferences.showClosedContacts
  // Hiding the closed section has to remove it from the count as well. A
  // "Contacts (12)" tab that opens onto nine rows reads as a rendering fault.
  const contactCount =
    activeTracks.length +
    unidentifiedTracks.length +
    (showClosed ? closedTracks.length : 0) +
    adsb.length
  const skyState = computeSkyState(health, activeTracks.length)

  const confirmed = activeTracks.filter((track) => track.state === 'CONFIRMED').length
  // A track with no position is real but unplottable. Surfacing the count is
  // the only thing that stops the map and the list disagreeing silently.
  const unplotted = activeTracks.filter((track) => !track.current).length

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
          onSelectTrack={selectTrack}
          selectedMannedIcao={selectedMannedIcao}
          onSelectManned={selectManned}
          coverageBroken={!skyState.absenceIsEvidence}
        />

        {/*
          The banner sits over the map rather than beside it. What an empty map
          means has to be readable in the same glance as the map itself.
        */}
        <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex flex-col gap-2 sm:inset-x-3 sm:top-3">
          <SkyStateBanner state={skyState} className="max-w-2xl" />
        </div>

        {preferences.mapLegend ? (
          <MapLegend className="absolute bottom-3 left-3 z-20 hidden sm:block" />
        ) : null}
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
        {/*
          The counts the map cannot show. "How many are up" is legible from the
          markers; "how many are corroborated" and "how many are missing from
          the map entirely" are not, and those are the two that change what the
          picture means.
        */}
        <div className="border-border grid grid-cols-2 gap-2 border-b p-2 sm:grid-cols-4 lg:grid-cols-2">
          <StatTile
            label="Active"
            value={activeTracks.length}
            icon={PlaneIcon}
            hint="tracks fusion is watching"
          />
          <StatTile
            label="Confirmed"
            value={confirmed}
            icon={RadarIcon}
            tone={confirmed > 0 ? 'ok' : 'default'}
            hint="corroborated by evidence"
          />
          <StatTile
            label="Manned"
            value={adsb.length}
            icon={SatelliteDishIcon}
            hint="ADS-B, context only"
          />
          <StatTile
            label="No position"
            value={unplotted}
            icon={MapPinOffIcon}
            tone={unplotted > 0 ? 'warn' : 'muted'}
            hint={unplotted > 0 ? 'in the list, not on the map' : 'all tracks plotted'}
          />
        </div>

        <ContactsPanel
          tracks={activeTracks}
          unidentifiedTracks={unidentifiedTracks}
          closedTracks={closedTracks}
          showClosed={showClosed}
          adsb={adsb}
          selectedTrackId={selectedTrackId}
          onSelectTrack={selectTrack}
          selectedMannedIcao={selectedMannedIcao}
          onSelectManned={selectManned}
          className="min-h-0 flex-1"
        />
      </aside>
    </div>
  )
}
