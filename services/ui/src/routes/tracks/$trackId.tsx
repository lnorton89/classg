import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  ActivityIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FingerprintIcon,
  HistoryIcon,
  LocateFixedIcon,
  RouteIcon,
  ScanSearchIcon,
  UserIcon,
} from 'lucide-react'

import { useFormat, useTicker } from '@/app/use-format'
import { CopyButton } from '@/components/ui/copy-button'
import { Alert, DataList, DataRow, EmptyState } from '@/components/ui/misc'
import { Badge } from '@/components/ui/badge'
import { Tooltip } from '@/components/ui/tooltip'
import { bearingDegrees, distanceMetres } from '@/features/map/geo'
import { TrackMap } from '@/features/map/track-map'
import { ConfidenceBar, EvidenceBreakdown, TrackStateBadge } from '@/features/tracks/evidence'
import { RssiChart } from '@/features/tracks/rssi-chart'
import { flightPath } from '@/features/tracks/flight-path'
import { samplesFromDetections } from '@/features/tracks/rssi-samples'
import {
  SortableTrackDetailGrid,
  type TrackDetailCard,
} from '@/features/tracks/sortable-detail-grid'
import { ShareTrack } from '@/features/tracks/share/share-track'
import {
  exportBasename,
  pathGeoJson,
  positionsCsv,
  rssiCsv,
} from '@/features/tracks/track-export'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { downloadText } from '@/features/logs/log-store'
import { ApiError } from '@/lib/api/client'
import { trackDetectionsQuery, trackPathQuery, trackQuery } from '@/lib/api/queries'
import type { Position, Track } from '@/lib/api/types'
import { EMPTY } from '@/lib/format'
import { PageContainer } from '@/components/layout/page-container'

export const Route = createFileRoute('/tracks/$trackId')({
  component: TrackDetail,
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(trackQuery(params.trackId, context.queryClient))
    } catch (error) {
      if (error instanceof ApiError && error.isNotFound) return notFound()
      throw error instanceof Error ? error : new Error(String(error))
    }
  },
  notFoundComponent: () => (
    <div className="p-6">
      <Alert
        tone="info"
        title="Track not found"
        action={
          <Link to="/tracks" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <ArrowLeftIcon className="size-4" aria-hidden />
            Back to tracks
          </Link>
        }
      >
        This track is not in the configured store. Closed tracks remain available until the
        retention window removes them; the memory store also resets whenever the API restarts.
      </Alert>
    </div>
  ),
})

/** An identity field that was never broadcast arrives as '' as often as null. */
function reported(value: string | null | undefined): string {
  return value != null && value !== '' ? value : EMPTY
}

function TrackDetail() {
  const { trackId } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: track } = useQuery(trackQuery(trackId, queryClient))
  const { data: detectionsData } = useQuery(trackDetectionsQuery(trackId))
  const { data: pathDetections } = useQuery(trackPathQuery(trackId))
  const format = useFormat()
  useTicker(5000)

  if (!track) return null

  const detections = detectionsData?.detections ?? []
  const rssiSamples = samplesFromDetections(detections)
  const serial = format.splitSerial(track.identity?.serial)
  const current = track.current
  const operator = track.operator
  // The track's own history is a ring buffer that drops its oldest points on a
  // long flight, so a detail page that reads it shows a route with the start
  // missing. Rebuilt from the detections instead -- see flightPath.
  const history = flightPath(pathDetections ?? [], track.history ?? [])
  const peakRssi = format.rssi(
    rssiSamples.length ? Math.max(...rssiSamples.map((sample) => sample.rssi)) : null,
  )

  // Card icons are muted by default. Colour is spent only where it keys back to
  // the map — the aircraft in `--track`, the operator in `--operator` — so a
  // coloured icon here means "this is the thing you are looking at on the map".
  const cards: TrackDetailCard[] = [
    {
      id: 'evidence',
      label: 'Detection evidence',
      icon: ScanSearchIcon,
      title: 'Why this is a detection',
      className: 'md:col-span-2',
      headerExtra: (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="font-mono text-lg leading-none font-semibold">
            {format.confidence(track.confidence)}
          </span>
          <ConfidenceBar confidence={track.confidence} className="w-32 self-center sm:w-40" />
          <span className="text-muted-foreground text-xs">confidence that this is a drone</span>
        </div>
      ),
      content: (
        <EvidenceBreakdown evidence={track.evidence ?? []} confidence={track.confidence} />
      ),
    },
    {
      id: 'identity',
      label: 'Identity',
      icon: FingerprintIcon,
      title: 'Identity',
      content: (
        <div className="space-y-3">
          <DataList label="Broadcast identity">
            <DataRow
              label="Serial"
              mono
              value={
                serial.manufacturerCode ? (
                  <span>
                    <Tooltip content="ANSI/CTA-2063-A manufacturer code. Decoded from the serial, so it survives MAC randomisation — unlike an OUI.">
                      <span className="text-primary underline decoration-dotted">
                        {serial.manufacturerCode}
                      </span>
                    </Tooltip>
                    {serial.rest}
                  </span>
                ) : (
                  EMPTY
                )
              }
            />
            {/* reported(), not `?? EMPTY`: identity fields arrive as empty
                strings when never broadcast, and `??` let those render as
                blank space -- a field that looks forgotten rather than one
                that reads "not reported". */}
            <DataRow label="Vendor" value={reported(track.identity?.vendor)} />
            <DataRow label="Model hint" value={reported(track.identity?.model_hint)} />
            <DataRow label="UA type" value={reported(track.identity?.ua_type)} />
            <DataRow label="Operator ID" value={reported(track.identity?.operator_id)} mono />
            <DataRow
              label="MACs"
              mono
              value={
                track.identity?.macs?.length ? (
                  <span className="flex flex-col items-end gap-0.5">
                    {track.identity.macs.map((mac) => (
                      <span key={mac} className="inline-flex items-center gap-1">
                        {mac}
                        <CopyButton value={mac} label="MAC address" />
                      </span>
                    ))}
                  </span>
                ) : (
                  EMPTY
                )
              }
            />
          </DataList>

          <DataList label="Activity">
            <DataRow label="Detections" value={track.detection_count} mono />
            <DataRow
              label={`First seen (${format.zoneLabel})`}
              value={format.timestamp(track.first_seen)}
              mono
            />
            {/* The age is the reading an operator scans for; the absolute stamp
                is what they quote later. Stacking them keeps both without
                running one long string off the edge of a narrow card. */}
            <DataRow
              label={`Last seen (${format.zoneLabel})`}
              value={format.timestamp(track.last_seen)}
              hint={format.relative(track.last_seen)}
              mono
            />
          </DataList>
        </div>
      ),
    },
    {
      id: 'flight',
      label: 'Flight path',
      icon: RouteIcon,
      title: 'Flight path',
      description:
        'Latest aircraft position, reported route, and operator ground position when available.',
      className: 'md:col-span-2 xl:col-span-3',
      contentClassName: 'p-0 pt-0',
      content: (
        <>
          <TrackMap track={track} path={history} />
          <PositionHistory history={history} track={track} />
        </>
      ),
    },
    {
      id: 'position',
      label: 'Current position',
      icon: LocateFixedIcon,
      iconClassName: 'text-track',
      title: 'Current position',
      content: current ? (
        <div className="space-y-3">
          <DataList label="Where">
            <DataRow
              label="Latitude, longitude"
              value={
                <span className="inline-flex items-center gap-1">
                  {format.coords(current.lat, current.lon)}
                  <CopyButton
                    value={`${current.lat.toFixed(6)}, ${current.lon.toFixed(6)}`}
                    label="coordinates"
                  />
                </span>
              }
              mono
            />
            <DataRow
              label="Geodetic altitude"
              value={format.length(current.alt_geodetic_m)}
              mono
            />
            <DataRow
              label="Height AGL"
              value={
                <Tooltip content="Some aircraft report height above the takeoff point rather than above ground level. The Mini 5 Pro does; see docs/ops/04-calibration.md.">
                  <span className="underline decoration-dotted">
                    {format.length(current.height_agl_m)}
                  </span>
                </Tooltip>
              }
              mono
            />
          </DataList>

          <DataList label="Motion">
            <DataRow label="Ground speed" value={format.speed(current.speed_mps)} mono />
            <DataRow label="Track" value={format.heading(current.track_deg)} mono />
            <DataRow
              label={`Reported at (${format.zoneLabel})`}
              value={format.clock(current.at)}
              hint={format.relative(current.at)}
              mono
            />
          </DataList>
        </div>
      ) : (
        <EmptyState title="No position reported">
          This track has identity evidence but no GPS fix, so it cannot be plotted. Coordinates
          of exactly 0,0 are normalised to absent rather than shown as the Gulf of Guinea.
        </EmptyState>
      ),
    },
    {
      id: 'operator',
      label: 'Operator position',
      icon: UserIcon,
      iconClassName: 'text-operator',
      title: 'Operator position',
      content: operator ? (
        <div className="space-y-3">
          <DataList label="Reported">
            <DataRow
              label="Latitude, longitude"
              value={format.coords(operator.lat, operator.lon)}
              mono
            />
            <DataRow label="Altitude" value={format.length(operator.alt_geodetic_m)} mono />
            <DataRow
              label={`Reported at (${format.zoneLabel})`}
              value={format.clock(operator.at)}
              hint={format.relative(operator.at)}
              mono
            />
          </DataList>

          {/* Split out because these two are computed here, not broadcast. Sat
              among the reported fields they read as something the aircraft
              said. */}
          {current ? (
            <DataList label="Derived from both positions">
              <DataRow
                label="Distance from aircraft"
                value={format.range(distanceMetres(current, operator))}
                mono
              />
              <DataRow
                label="Bearing from aircraft"
                value={format.heading(bearingDegrees(current, operator))}
                mono
              />
            </DataList>
          ) : null}
        </div>
      ) : (
        <EmptyState icon={UserIcon} title="Not broadcast">
          Operator position comes from an ASTM F3411 System message or DJI DroneID{' '}
          <code>0x10</code>; many tracks never carry one. This is a normal state, not an error.
        </EmptyState>
      ),
    },
    {
      id: 'signal',
      label: 'Signal strength',
      icon: ActivityIcon,
      title: 'Signal strength over time',
      description: `${rssiSamples.length} RSSI samples · peak ${peakRssi}`,
      content: (
        <>
          <RssiChart samples={rssiSamples} height={160} />
          {rssiSamples.length > 0 ? (
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadText(
                    `${exportBasename(track)}-rssi.csv`,
                    'text/csv',
                    rssiCsv(rssiSamples),
                  )
                }
              >
                <DownloadIcon aria-hidden />
                RSSI CSV
              </Button>
            </div>
          ) : null}
        </>
      ),
    },
  ]

  return (
    <PageContainer>
      <header className="min-w-0">
        <Link
          to="/tracks"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded text-xs"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden /> All tracks
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <h1 className="min-w-0 font-mono text-xl font-semibold tracking-tight break-all sm:text-2xl">
            {track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id}
          </h1>
          <CopyButton
            value={track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id}
            label="identifier"
          />
          <TrackStateBadge state={track.state} />
          {track.adsb_correlated ? (
            <Tooltip content="Correlated with an ADS-B contact. Fusion uses this to suppress energy-only false positives; it never suppresses a decoded Remote ID.">
              <Badge variant="warn">ADS-B correlated</Badge>
            </Tooltip>
          ) : null}
        </div>
        <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1 font-mono">
            {track.track_id}
            <CopyButton value={track.track_id} label="track ID" />
          </span>
          <span>{track.detection_count} detections</span>
          <span>Last seen {format.when(track.last_seen)}</span>
          <span>Peak RSSI {peakRssi}</span>
        </div>

        <div className="mt-3">
          <ShareTrack track={track} rssiSamples={rssiSamples} />
        </div>
      </header>

      <SortableTrackDetailGrid cards={cards} />
    </PageContainer>
  )
}

/**
 * How many rows this panel will draw.
 *
 * Every point is rendered twice -- once as a card for narrow screens, once as a
 * table row for wide ones, with `lg:hidden` choosing between them in CSS rather
 * than in React. The panel is a <details>, and its contents mount whether or
 * not it is open, so that cost is paid on every page load.
 *
 * That was tolerable when the path was capped at a few hundred points. Now that
 * it is rebuilt from detections it can be thousands, and reading down a table of
 * thousands is not something anybody does -- the map is how you look at a path.
 * The count in the summary stays the true total, so the number is never a lie
 * about what was recorded; only the drawing is bounded.
 */
const HISTORY_ROWS = 500

function PositionHistory({ history, track }: { history: Position[]; track: Track }) {
  const format = useFormat()
  // Reversed once, here, instead of separately in each of the two renderings.
  const rows = [...history].reverse().slice(0, HISTORY_ROWS)
  const hidden = history.length - rows.length

  return (
    <details className="group border-border border-t">
      <summary className="hover:bg-accent/30 focus-visible:ring-ring flex cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        <HistoryIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="font-medium">Position history</span>
        <span className="text-muted-foreground text-xs">
          {history.length} reported points
          {hidden > 0 ? ` (newest ${HISTORY_ROWS} listed)` : ''}
        </span>
        {/* The order is not obvious from a table of timestamps alone, and
            reading it backwards inverts every climb and descent. */}
        <span className="text-muted-foreground ml-auto hidden text-xs sm:inline">
          Newest first
        </span>
      </summary>

      <div className="border-border bg-muted/10 border-t p-3">
        {/* The whole recorded flight, not the HISTORY_ROWS render cap: the
            export exists precisely for the data too long to read on screen.
            CSV for spreadsheets; GeoJSON drops straight onto any map tool,
            already in its lon-lat order. */}
        {history.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-1.5 px-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadText(
                  `${exportBasename(track)}-path.csv`,
                  'text/csv',
                  positionsCsv(history),
                )
              }
            >
              <DownloadIcon aria-hidden />
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadText(
                  `${exportBasename(track)}-path.geojson`,
                  'application/geo+json',
                  pathGeoJson(track, history),
                )
              }
            >
              <DownloadIcon aria-hidden />
              GeoJSON
            </Button>
          </div>
        ) : null}
        {history.length === 0 ? (
          <p className="text-muted-foreground px-1 py-3 text-sm">No position history.</p>
        ) : (
          <div className="max-h-80 overflow-auto [scrollbar-gutter:stable_both-edges]">
            {/* Stacked below lg. Six columns of coordinates and figures need
                about 42rem; a phone has 24, so five of the six were off the
                right edge of a sideways scroll nested inside a vertical one.
                The time and the position lead, because those are what somebody
                scrubbing a track's history is reading down. */}
            <ul className="space-y-2 pr-1 pb-2 lg:hidden">
              {rows.map((position, index) => (
                <li
                  key={`${position.at ?? index}-${position.lat}`}
                  className="border-border/60 rounded-md border px-2.5 py-2 font-mono text-2xs"
                >
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-foreground">{format.clock(position.at)}</span>
                    <span className="text-muted-foreground">
                      {format.coords(position.lat, position.lon)}
                    </span>
                  </p>
                  <dl className="tnum mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground font-sans">AGL</dt>
                      <dd>{format.length(position.height_agl_m)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground font-sans">Geodetic</dt>
                      <dd>{format.length(position.alt_geodetic_m)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground font-sans">Speed</dt>
                      <dd>{format.speed(position.speed_mps)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground font-sans">Track</dt>
                      <dd>{format.heading(position.track_deg)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>

            <div className="hidden pr-3 pb-3 lg:block">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Reported aircraft position history</caption>
                <thead className="text-muted-foreground bg-card sticky top-0 z-10">
                  <tr className="border-border border-b">
                    <th scope="col" className="py-2 pr-4 pl-2 font-medium">
                      Time ({format.zoneLabel})
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Latitude, longitude
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      AGL
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Geodetic
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Speed
                    </th>
                    <th scope="col" className="py-2 pr-2 text-right font-medium">
                      Track
                    </th>
                  </tr>
                </thead>
                {/* Zebra rather than rules: six columns is wide enough that the
                    eye drifts a row between the timestamp and the heading. */}
                <tbody className="font-mono">
                  {rows.map((position, index) => (
                    <tr
                      key={`${position.at ?? index}-${position.lat}`}
                      className="odd:bg-foreground/[0.035] hover:bg-accent/40"
                    >
                      <td className="py-1.5 pr-4 pl-2 whitespace-nowrap">
                        {format.clock(position.at)}
                      </td>
                      <td className="py-1.5 pr-4 whitespace-nowrap">
                        {format.coords(position.lat, position.lon)}
                      </td>
                      <td className="py-1.5 pr-4 text-right whitespace-nowrap">
                        {format.length(position.height_agl_m)}
                      </td>
                      <td className="py-1.5 pr-4 text-right whitespace-nowrap">
                        {format.length(position.alt_geodetic_m)}
                      </td>
                      <td className="py-1.5 pr-4 text-right whitespace-nowrap">
                        {format.speed(position.speed_mps)}
                      </td>
                      <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                        {format.heading(position.track_deg)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </details>
  )
}
