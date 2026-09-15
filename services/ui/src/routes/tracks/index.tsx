import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ArchiveIcon,
  HelpCircleIcon,
  HistoryIcon,
  ListIcon,
  RadarIcon,
  RadioTowerIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { Button } from '@/components/ui/button'
import { TeachingHelpButton } from '@/components/ui/teaching-banner'
import { useTeaching } from '@/components/ui/use-teaching'
import { TRACK_STATE_KEY_TITLE, TrackStateKey } from '@/features/tracks/evidence'
import { FlightFilterBar, type GroupMode } from '@/features/tracks/flight-filter-bar'
import { filterFlights, type FlightFilters } from '@/features/tracks/flight-filters'
import { DEFAULT_FLIGHT_SORT, type FlightSort } from '@/features/tracks/flight-metrics'
import { flightWindowMs, windowSince, type WindowChip } from '@/features/tracks/flight-time'
import { tracksSearchSchema, type TracksSearch } from '@/features/tracks/tracks-search'
import { FlightsHistogram } from '@/features/tracks/flights-histogram'
import { scrollFlightIntoView } from '@/features/tracks/flight-row'
import { FlightsTable } from '@/features/tracks/flights-table'
import { partitionTracks } from '@/features/tracks/partition'
import { FlightLanes } from '@/features/timeline/flight-lanes'
import { Segmented } from '@/components/ui/segmented'
import { TracksTable } from '@/features/tracks/tracks-table'
import { closedTracksHistoryQuery, settingsQuery, tracksQuery } from '@/lib/api/queries'
import { asReceiverPosition, type Track } from '@/lib/api/types'
import { PageContainer } from '@/components/layout/page-container'
import { PageHeader, SectionHeader } from '@/components/layout/page-header'

/**
 * List state lives in the URL, not in component state.
 *
 * The page reset its filters, its sort and its window every time someone opened
 * a flight and pressed Back, which on a list whose whole purpose is narrowing
 * meant doing the narrowing again per flight. Same convention as
 * routes/sensors.tsx and routes/admin.tsx.
 *
 * The schema itself moved to `features/tracks/tracks-search.ts` so the header's
 * search box can build links with it rather than hand-writing `?q=`; it is
 * re-exported here because this is where it is the route's contract.
 */
export { tracksSearchSchema, type TracksSearch }

export const Route = createFileRoute('/tracks/')({
  component: TracksView,
  validateSearch: tracksSearchSchema,
  loader: ({ context }) => context.queryClient.ensureQueryData(tracksQuery()),
})

function TracksView() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { preferences } = usePreferences()
  const utc = preferences.timeZone === 'utc'
  const stateKey = useTeaching('track-state-key')

  // replace: true -- narrowing a list is not a new page to walk back through.
  // Back should leave the page, and land on the view it was left in.
  function setSearch(patch: Partial<TracksSearch>) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }

  const windowChip: WindowChip = search.since ?? 'all'
  const group: GroupMode = search.group ?? 'aircraft'
  const sort: FlightSort = search.sort ?? DEFAULT_FLIGHT_SORT
  const view = search.view ?? 'list'

  /*
   * Which flight the band and the list are both pointing at.
   *
   * Session state rather than a URL key: it is where the operator's eye is
   * inside one view, not part of what a shared link to this page means. The
   * list's own quick view keeps its internal state in the plain list view; in
   * lanes it is handed this one, so a bar and a row cannot disagree about which
   * flight is open.
   */
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null)

  // Anchored rather than read per render: a `Date.now()` in the render body
  // would mint a new `since`, and therefore a new query key, on every repaint.
  const [anchorMs, setAnchorMs] = useState(() => Date.now())
  const since = useMemo(
    () => windowSince(windowChip, anchorMs, utc),
    [windowChip, anchorMs, utc],
  )

  const { data } = useQuery(tracksQuery())
  const tracks = data?.tracks ?? []
  const {
    active: activeTracks,
    unidentified: unidentifiedTracks,
    closed: liveClosed,
  } = partitionTracks(tracks)

  const { data: settings } = useQuery(settingsQuery())
  const receiver = asReceiverPosition(settings?.settings['map.receiver_position']?.value)

  // The live list holds one server page, so on a unit with weeks of history it
  // silently ended at whatever the API's page size is. History is paged on the
  // cursor instead, with the tracks the socket closed this session merged over
  // it -- they are fresher than any fetched page.
  const history = useInfiniteQuery(closedTracksHistoryQuery(since))
  const closedTracks = useMemo(() => {
    const byId = new Map<string, Track>()
    for (const page of history.data?.pages ?? []) {
      for (const track of page.tracks) byId.set(track.track_id, track)
    }
    for (const track of liveClosed) {
      // A socket-closed track from before the window would reappear in a
      // filtered view the server had already excluded it from.
      if (since !== undefined && track.last_seen < since) continue
      byId.set(track.track_id, track)
    }
    return [...byId.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))
  }, [history.data, liveClosed, since])
  // The last page's total is the server's current count of everything closed,
  // which is what makes "N of M" honest when M is bigger than what is loaded.
  const closedTotal = history.data?.pages.at(-1)?.total

  // Duration and Detections are chips but not URL keys: they are a
  // within-session narrowing rather than part of what a shared link means.
  const [minDurationS, setMinDurationS] = useState<number | undefined>(undefined)
  const [minDetections, setMinDetections] = useState<number | undefined>(undefined)

  const filters: FlightFilters = useMemo(
    () => ({
      q: search.q,
      day: search.day,
      vendor: search.vendor,
      evidence: search.evidence,
      operator: search.operator,
      minDurationS,
      minDetections,
    }),
    [
      search.q,
      search.day,
      search.vendor,
      search.evidence,
      search.operator,
      minDurationS,
      minDetections,
    ],
  )

  const visibleClosed = useMemo(
    () => filterFlights(closedTracks, filters, utc),
    [closedTracks, filters, utc],
  )
  const filtering = visibleClosed.length !== closedTracks.length

  // The band's axis: the same span the list is narrowed to, so a bar's position
  // and a row's Start column are two readings of one clock.
  const bandWindow = useMemo(
    () => flightWindowMs(visibleClosed, windowChip, search.day, anchorMs, utc),
    [visibleClosed, windowChip, search.day, anchorMs, utc],
  )

  function onFiltersChange(next: FlightFilters) {
    setMinDurationS(next.minDurationS)
    setMinDetections(next.minDetections)
    setSearch({
      q: next.q,
      day: next.day,
      vendor: next.vendor,
      evidence: next.evidence,
      operator: next.operator,
    })
  }

  return (
    <PageContainer>
      {/*
        "Flights", not "Tracks". A track is fusion's internal object — a
        correlation of detections under one identity — and the page has been
        about flights since the redesign. The route stays `/tracks` because the
        URL is in bookmarks and in the operator guide; only the word an operator
        reads changes. What a track IS now lives in the state key below and in
        the in-app docs, rather than in the page's one-line description.
      */}
      <PageHeader
        icon={RadarIcon}
        title="Flights"
        description="Every flight this unit has heard, grouped by aircraft."
        actions={<TeachingHelpButton teaching={stateKey} title={TRACK_STATE_KEY_TITLE} />}
      />

      <TrackStateKey teaching={stateKey} />

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

      {/*
        partitionTracks has always produced this bucket and the page never
        rendered it, so a class-C/D/H-only contact — RF that looked drone-like
        and was never identified as an aircraft — existed in the data and
        nowhere on screen. It gets its own section rather than a row in the
        active table: the whole reason the partition exists is that folding the
        two together made one aircraft read as two (2026-08-17).
      */}
      {unidentifiedTracks.length > 0 ? (
        <section
          aria-labelledby="unidentified-tracks-heading"
          className="flex min-h-0 flex-col gap-2"
        >
          <SectionHeader
            id="unidentified-tracks-heading"
            icon={HelpCircleIcon}
            title={`Unidentified contacts (${unidentifiedTracks.length})`}
            description="RF consistent with a drone that nothing has identified as one — an OUI or SSID match, ADS-B context, or a GNSS indicator. Corroborating evidence only; not counted as aircraft."
          />
          <TracksTable
            tracks={unidentifiedTracks}
            caption="Unidentified contacts, sortable by column and filterable by identity and state"
            emptyTitle="No unidentified contacts"
            excludeStates={['CLOSED']}
          />
        </section>
      ) : null}

      <section aria-labelledby="closed-tracks-heading" className="flex min-h-0 flex-col gap-3">
        <SectionHeader
          id="closed-tracks-heading"
          icon={ArchiveIcon}
          title={
            closedTotal !== undefined && closedTotal > closedTracks.length
              ? `Flight history (${closedTracks.length} of ${closedTotal})`
              : `Flight history (${closedTracks.length})`
          }
          description="One row per flight, grouped by aircraft. Expand a row for its path and numbers, or open it for the full record."
          actions={
            /*
              The Timeline page, folded in. It was answering this section's
              question over its own copy of this section's state, so picking a
              day here and switching there silently lost the day. Same window,
              same filters, two renderings.
            */
            <Segmented
              aria-label="How to show these flights"
              value={view}
              onValueChange={(next) => {
                // Absent rather than 'list': the default belongs in the code,
                // not in every URL this page produces.
                setSearch({ view: next === 'list' ? undefined : next })
              }}
              options={[
                { value: 'list', label: 'List', icon: <ListIcon aria-hidden /> },
                { value: 'lanes', label: 'Lanes', icon: <HistoryIcon aria-hidden /> },
              ]}
            />
          }
        />

        <FlightsHistogram
          tracks={closedTracks}
          utc={utc}
          day={search.day}
          onDayChange={(day) => setSearch({ day })}
          window={windowChip}
          onWindowChange={(next) => {
            setAnchorMs(Date.now())
            // Absent rather than 'all': the default belongs in the code, not
            // in every URL this page produces.
            setSearch({ since: next === 'all' ? undefined : next })
          }}
        />

        <FlightFilterBar
          tracks={closedTracks}
          filters={filters}
          onFiltersChange={onFiltersChange}
          group={group}
          onGroupChange={(next) => setSearch({ group: next === 'aircraft' ? undefined : next })}
          utc={utc}
          resultCount={visibleClosed.length}
        />

        {view === 'lanes' ? (
          <FlightLanes
            tracks={visibleClosed}
            window={bandWindow}
            selectedId={selectedFlightId}
            onSelect={(trackId) => {
              setSelectedFlightId(trackId)
              // The row is the answer to "which one was that"; a bar on a
              // seven-day band a few pixels wide is not.
              if (trackId !== null) scrollFlightIntoView(trackId)
            }}
            pending={history.isPending}
            // The API caps a page at 1000. More than that in one window means
            // the band is not the whole story, and saying so beats quietly
            // drawing a subset.
            truncated={closedTracks.length >= 1000}
          />
        ) : null}

        <FlightsTable
          tracks={visibleClosed}
          receiver={receiver}
          group={group}
          sort={sort}
          onSortChange={(next) =>
            setSearch({ sort: next === DEFAULT_FLIGHT_SORT ? undefined : next })
          }
          utc={utc}
          caption="Closed flights, grouped by aircraft and sortable by column"
          emptyTitle="No closed tracks"
          emptyDescription="Tracks appear here after their closure timeout expires."
          filtered={filtering}
          // Controlled only in lanes: the plain list has nothing else pointing
          // at a flight, and handing it a selection it alone can change would
          // be state for its own sake.
          expandedId={view === 'lanes' ? selectedFlightId : undefined}
          onExpandedChange={view === 'lanes' ? setSelectedFlightId : undefined}
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
