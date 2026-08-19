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
import type { ReactNode } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { Segmented } from '@/components/ui/segmented'
import { Panel, ResizableSplit, ResizeHandle } from '@/components/ui/resizable'
import { LG_QUERY, useMediaQuery } from '@/lib/use-media-query'
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

  const map = (
    <>
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

      {preferences.mapLegend ? (
        <MapLegend className="absolute bottom-3 left-3 z-20 hidden sm:block" />
      ) : null}
    </>
  )

  // Placed by ResponsiveSplit rather than inside the map fragment: on a phone
  // the map pane can be hidden behind the Contacts toggle, and "you are no
  // longer watching the airspace" must not be hidden with it.
  const banner = <SkyStateBanner state={skyState} className="max-w-2xl" />

  // Only rendered in the narrow layout; the wide one has both panes at once.
  const toggle = (
    <div className="border-border bg-card sticky top-14 z-30 border-b p-2">
      <Segmented
        aria-label="Show the map or the contact list"
        value={mobilePane}
        onValueChange={setMobilePane}
        options={[
          { value: 'map', label: 'Map', icon: <MapIcon aria-hidden /> },
          {
            value: 'list',
            label: `Contacts (${contactCount})`,
            icon: <ListIcon aria-hidden />,
          },
        ]}
        className="flex w-full"
      />
    </div>
  )

  const contacts = (
    <>
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
    </>
  )

  return (
    <ResponsiveSplit
      map={map}
      banner={banner}
      toggle={toggle}
      contacts={contacts}
      mobilePane={mobilePane}
    />
  )
}

/**
 * One layout below lg, a draggable split above it.
 *
 * The 24rem contacts rail was a fixed width chosen once. On a wall display it
 * wastes a third of the map; on a 13-inch laptop the identity column truncates
 * every serial. Which of those matters is the operator's call and nobody
 * else's, so it is a handle now -- remembered per browser, because a wall
 * display and a laptop want different answers and re-dragging on every load is
 * the kind of tax that makes people stop bothering.
 *
 * Below lg there is no split to make: the panes stack, one is shown at a time
 * by the toggle, and a divider would only be a way to make one of them too
 * small to read.
 *
 * This is a media QUERY rather than two class-hidden trees, and that is not a
 * style preference. Rendering both and letting CSS hide one would mount the
 * map twice -- two MapLibre instances, two WebGL contexts -- to show one map.
 */
function ResponsiveSplit({
  map,
  banner,
  toggle,
  contacts,
  mobilePane,
}: {
  map: ReactNode
  banner: ReactNode
  toggle: ReactNode
  contacts: ReactNode
  mobilePane: 'map' | 'list'
}) {
  const wide = useMediaQuery(LG_QUERY)

  if (wide) {
    return (
      <ResizableSplit id="live-map-contacts">
        {/* minSize on both: a drag that collapses either side to nothing
            leaves an operator who did it by accident with no obvious way
            back, and a map at 10% is not a map. */}
        <Panel defaultSize="70%" minSize="35%" className="relative min-h-0">
          {map}
          {/*
              The banner sits over the map rather than beside it. What an empty
              map means has to be readable in the same glance as the map itself.
            */}
          <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex flex-col gap-2 sm:inset-x-3 sm:top-3">
            {banner}
          </div>
        </Panel>
        <ResizeHandle />
        <Panel
          defaultSize="30%"
          minSize="18%"
          className="border-border bg-card flex min-h-0 flex-col border-l"
        >
          <aside aria-label="Contacts" className="flex min-h-0 flex-1 flex-col">
            {contacts}
          </aside>
        </Panel>
      </ResizableSplit>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* In flow above both panes, not overlaid on the map: the map pane is
          `hidden` while the list is showing, and the coverage banner must
          survive that. empty:hidden swallows the wrapper when the banner has
          dismissed itself. */}
      <div className="px-2 pt-2 empty:hidden">{banner}</div>
      <div className={cn('relative min-h-[55dvh] flex-1', mobilePane === 'list' && 'hidden')}>
        {map}
      </div>
      {toggle}
      <aside
        aria-label="Contacts"
        className={cn(
          'border-border bg-card flex min-h-0 flex-col',
          mobilePane === 'map' && 'hidden',
        )}
      >
        {contacts}
      </aside>
    </div>
  )
}
