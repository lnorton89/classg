import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  ClockIcon,
  DownloadIcon,
  GaugeIcon,
  HistoryIcon,
  RadioIcon,
  RouteIcon,
  UserIcon,
} from 'lucide-react'
import { memo, useMemo, useState } from 'react'

import { usePreferences } from '@/app/preferences-context'
import { useFormat, useTicker } from '@/app/use-format'
import { CopyButton } from '@/components/ui/copy-button'
import { Alert, DataList, DataRow, EmptyState } from '@/components/ui/misc'
import { StatusPill } from '@/components/ui/status-pill'
import { Segmented } from '@/components/ui/segmented'
import { MetricStrip } from '@/components/ui/metric-strip'
import { Tooltip } from '@/components/ui/tooltip'
import { bearingDegrees, distanceMetres } from '@/features/map/geo'
import {
  colouredPath,
  PATH_COLOUR_LABELS,
  PATH_COLOUR_MODES,
  type PathColourMode,
} from '@/features/map/path-colour'
import { TrackMap } from '@/features/map/track-map'
import { AircraftFlights } from '@/features/tracks/aircraft-flights'
import { AircraftFlagBadge, AircraftLabelControl } from '@/features/tracks/aircraft-label'
import { ConfidenceBar, EvidenceBreakdown, TrackStateBadge } from '@/features/tracks/evidence'
import { FlightProfiles } from '@/features/tracks/flight-profiles'
import {
  flightDurationS,
  maxHeightAglM,
  maxRangeM,
  maxSpeedMps,
} from '@/features/tracks/flight-metrics'
import { frameAt, playbackSpan, type PlaybackRate } from '@/features/tracks/flight-playback'
import { FlightScrubber } from '@/features/tracks/flight-scrubber'
import {
  DERIVED_MARK,
  heightProvenance,
  heightProvenanceHint,
} from '@/features/tracks/height-provenance'
import { ReceiverBreakdown } from '@/features/tracks/receivers'
import { flightPath } from '@/features/tracks/flight-path'
import { samplesFromDetections, type RssiSample } from '@/features/tracks/rssi-samples'
import { ShareTrack } from '@/features/tracks/share/share-track'
import { useAircraftLabel } from '@/features/tracks/use-aircraft-label'
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
import {
  settingsQuery,
  trackDetectionsQuery,
  trackPathQuery,
  trackQuery,
} from '@/lib/api/queries'
import {
  asReceiverPosition,
  type Position,
  type ReceiverPosition,
  type Track,
} from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { EMPTY, formatDuration } from '@/lib/format'
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
            All flights
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

/**
 * The track detail page.
 *
 * It used to be six equally weighted cards the operator could drag into any
 * order, which is what a page with no hierarchy looks like: the map — the thing
 * the page was opened for — sat below the fold under two cards that said the
 * same thing on every class-A track. The order is fixed now, and it is fixed in
 * the order the questions are asked: what is this, how did it go, where did it
 * fly, what did the numbers do, who is it, and what else has it done.
 *
 * See docs/research/08-tracks-ux.md, "Proposal: Track detail".
 */
function TrackDetail() {
  const { trackId } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: track } = useQuery(trackQuery(trackId, queryClient))
  const { data: detectionsData } = useQuery(trackDetectionsQuery(trackId))
  const { data: pathDetections } = useQuery(trackPathQuery(trackId))
  const { data: settings } = useQuery(settingsQuery())
  const { preferences } = usePreferences()
  const format = useFormat()
  useTicker(5000)

  // Seeded from the preference rather than bound to it: changing the default in
  // Settings must not rearrange a map somebody is reading. The next flight they
  // open picks it up, which is how the old card-order reset behaved too.
  const [colourMode, setColourMode] = useState<PathColourMode>(preferences.trackPathColour)
  const [scrubMs, setScrubMs] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState<PlaybackRate>(1)
  const [hoverMs, setHoverMs] = useState<number | null>(null)

  const detections = useMemo(() => detectionsData?.detections ?? [], [detectionsData])
  // The track's own history is a ring buffer that drops its oldest points on a
  // long flight, so a detail page that reads it shows a route with the start
  // missing. Rebuilt from the detections instead -- see flightPath.
  const history = useMemo(
    () => flightPath(pathDetections ?? [], track?.history ?? []),
    [pathDetections, track],
  )
  // Memoised because it walks every point and is handed to MapLibre as a
  // source: recomputing it on a scrub tick would re-upload the whole route
  // twenty times a second.
  const coloured = useMemo(() => colouredPath(history, colourMode), [history, colourMode])
  const span = useMemo(() => playbackSpan(history), [history])
  // Sorts a few thousand detections. Playback re-renders this component ten
  // times a second, and an unmemoised sort there is the whole frame budget.
  const rssiSamples = useMemo(() => samplesFromDetections(detections), [detections])

  if (!track) return null

  // Absent on tracks recorded before fusion attributed them, so this is a
  // normal empty rather than a fault.
  const receivers = track.receivers ?? []
  const serial = format.splitSerial(track.identity?.serial)
  const current = track.current
  const operator = track.operator
  const receiver = asReceiverPosition(settings?.settings['map.receiver_position']?.value)
  const currentHeight = heightProvenance(current)
  // reduce rather than Math.max(...spread): a few thousand samples is past the
  // argument limit some engines enforce, and this is the pooled peak used only
  // as a fallback where per-receiver attribution is missing.
  const peakRssi = format.rssi(
    rssiSamples.length
      ? rssiSamples.reduce((max, sample) => Math.max(max, sample.rssi), -Infinity)
      : null,
  )

  const atMs = scrubMs ?? span?.startMs ?? null
  const frame = atMs === null ? null : frameAt(history, atMs)
  // The scrubber owns the cursor while it is playing; a pointer over a profile
  // takes it otherwise. Two sources for one cursor, and the one the operator is
  // actively driving wins.
  const cursorMs = playing ? atMs : (hoverMs ?? atMs)
  const cursorFrame = cursorMs === null ? null : frameAt(history, cursorMs)

  return (
    <PageContainer>
      <TrackHeader track={track} history={history} rssiSamples={rssiSamples} />

      <SummaryStrip track={track} history={history} receiver={receiver} />

      <section aria-labelledby="flight-map-heading" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="flight-map-heading" className="flex items-center gap-2 text-sm font-semibold">
            <RouteIcon className="text-muted-foreground size-4" aria-hidden />
            Flight path
          </h2>
          <Segmented
            aria-label="Colour the path by"
            value={colourMode}
            onValueChange={setColourMode}
            options={PATH_COLOUR_MODES.map((mode) => ({
              value: mode,
              label: PATH_COLOUR_LABELS[mode],
            }))}
            className="text-xs"
          />
        </div>

        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <TrackMap
            track={track}
            path={history}
            colouredPath={colourMode === 'none' ? null : coloured}
            colourMode={colourMode}
            cursor={
              cursorFrame
                ? {
                    lat: cursorFrame.lat,
                    lon: cursorFrame.lon,
                    label: `Replay position at ${format.clock(new Date(cursorFrame.atMs).toISOString())}${
                      cursorFrame.heard ? '' : ' — not heard, held at the last fix'
                    }`,
                  }
                : null
            }
          />
          {span ? (
            <FlightScrubber
              span={span}
              atMs={atMs ?? span.startMs}
              onScrub={setScrubMs}
              playing={playing}
              onPlayingChange={setPlaying}
              rate={rate}
              onRateChange={setRate}
              heard={frame?.heard ?? true}
            />
          ) : null}
        </div>
      </section>

      <section aria-labelledby="profiles-heading" className="flex flex-col gap-2">
        <h2 id="profiles-heading" className="flex items-center gap-2 text-sm font-semibold">
          <GaugeIcon className="text-muted-foreground size-4" aria-hidden />
          Profiles
        </h2>
        <div className="border-border bg-card rounded-lg border p-3">
          {span ? (
            <FlightProfiles
              path={history}
              detections={detections}
              domain={{ startMs: span.startMs, endMs: span.endMs }}
              cursorMs={cursorMs}
              onHoverMs={setHoverMs}
            />
          ) : (
            <p className="text-muted-foreground text-xs">
              Nothing on this track carries a usable timestamp, so there is no axis to plot
              against.
            </p>
          )}
          {rssiSamples.length > 0 ? (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  downloadText(
                    `${exportBasename(track)}-rssi.csv`,
                    'text/csv',
                    rssiCsv(rssiSamples),
                  )
                }}
              >
                <DownloadIcon aria-hidden />
                RSSI CSV
              </Button>
            </div>
          ) : null}
        </div>

        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <PositionHistory history={history} track={track} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="identity-heading" className="flex flex-col gap-2">
          <h2 id="identity-heading" className="text-sm font-semibold">
            Identity
          </h2>
          <div className="border-border bg-card space-y-3 rounded-lg border p-3">
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
              <DataRow
                label="Track ID"
                mono
                value={
                  <span className="inline-flex items-center gap-1">
                    {track.track_id}
                    <CopyButton value={track.track_id} label="track ID" />
                  </span>
                }
              />
            </DataList>

            {current ? (
              <DataList label="Last reported position">
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
                {/* The hint is the provenance, not decoration: a height fusion
                    derived from a terrain model and one the aircraft broadcast
                    are the same number rendered the same way, and only one of
                    them is a measurement. See heightProvenance. */}
                <DataRow
                  label="Height AGL"
                  value={
                    <Tooltip content="Some aircraft report height above the takeoff point rather than above ground level. The Mini 5 Pro does; see docs/ops/04-calibration.md.">
                      <span className="underline decoration-dotted">
                        {format.length(current.height_agl_m)}
                      </span>
                    </Tooltip>
                  }
                  hint={
                    currentHeight
                      ? heightProvenanceHint(currentHeight, format.length)
                      : undefined
                  }
                  mono
                />
              </DataList>
            ) : (
              <EmptyState title="No position reported">
                This track has identity evidence but no GPS fix, so it cannot be plotted.
                Coordinates of exactly 0,0 are normalised to absent rather than shown as the
                Gulf of Guinea.
              </EmptyState>
            )}

            {operator ? (
              <DataList label="Operator position">
                <DataRow
                  label="Latitude, longitude"
                  value={format.coords(operator.lat, operator.lon)}
                  mono
                />
                <DataRow label="Altitude" value={format.length(operator.alt_geodetic_m)} mono />
                {/* Computed here, not broadcast. Sat among the reported fields
                    they read as something the aircraft said. */}
                {current ? (
                  <DataRow
                    label="Distance from aircraft"
                    value={format.range(distanceMetres(current, operator))}
                    hint={`bearing ${format.heading(bearingDegrees(current, operator))}`}
                    mono
                  />
                ) : null}
              </DataList>
            ) : (
              <p className="text-muted-foreground text-2xs leading-relaxed">
                <UserIcon className="mr-1 inline size-3" aria-hidden />
                No operator position. It comes from an ASTM F3411 System message or DJI DroneID{' '}
                <code>0x10</code>; many tracks never carry one. A normal state, not an error.
              </p>
            )}

            <EvidenceLine track={track} />
          </div>
        </section>

        <section aria-labelledby="receivers-heading" className="flex flex-col gap-2">
          <h2 id="receivers-heading" className="flex items-center gap-2 text-sm font-semibold">
            <RadioIcon className="text-muted-foreground size-4" aria-hidden />
            Receivers
          </h2>
          <div className="border-border bg-card rounded-lg border p-3">
            {receivers.length > 0 ? (
              <ReceiverBreakdown receivers={receivers} />
            ) : (
              <p className="text-muted-foreground text-xs">
                This track carries no per-receiver attribution. Tracks recorded before fusion
                attributed them still load; the pooled peak is {peakRssi}.
              </p>
            )}
          </div>
        </section>
      </div>

      {track.identity?.serial ? (
        <AircraftFlights
          serial={track.identity.serial}
          trackId={track.track_id}
          receiver={receiver}
        />
      ) : null}
    </PageContainer>
  )
}

/**
 * Label or serial, what kind of aircraft, when it flew, and what can be done
 * with the record.
 *
 * The old header repeated the same identifier three times and then a card
 * below repeated it again. This states it once.
 */
function TrackHeader({
  track,
  history,
  rssiSamples,
}: {
  track: Track
  history: Position[]
  rssiSamples: RssiSample[]
}) {
  const format = useFormat()
  const serial = track.identity?.serial ?? null
  const label = useAircraftLabel(serial)
  const identifier = serial ?? track.identity?.macs?.[0] ?? track.track_id
  // A label record can exist carrying only a flag, so the empty string has to
  // fall through to the identifier rather than title the page with nothing.
  const named = label?.label === '' ? undefined : label?.label
  const title = named ?? identifier
  const hints = [track.identity?.vendor, track.identity?.model_hint, track.identity?.ua_type]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' · ')

  return (
    <header className="min-w-0">
      <Link
        to="/tracks"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded text-xs"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden /> All flights
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <h1
          className={cn(
            'min-w-0 text-xl font-semibold tracking-tight break-all sm:text-2xl',
            // A serial is an identifier and set in the mono face; a name
            // somebody typed is prose and is not.
            named === undefined && 'font-mono',
          )}
        >
          {title}
        </h1>
        <CopyButton value={identifier} label="identifier" />
        <TrackStateBadge state={track.state} />
        {label ? <AircraftFlagBadge flag={label.flag} /> : null}
        {track.adsb_correlated ? (
          <Tooltip content="Correlated with an ADS-B contact. Fusion uses this to suppress energy-only false positives; it never suppresses a decoded Remote ID.">
            <StatusPill tone="warn">ADS-B correlated</StatusPill>
          </Tooltip>
        ) : null}
      </div>

      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {/* Once a label carries the title, the serial still has to be on the
            page: it is what an operator quotes into a report, and a name they
            invented is not. */}
        {named !== undefined ? <span className="font-mono break-all">{identifier}</span> : null}
        {hints ? <span>{hints}</span> : null}
        <span className="tnum">
          <ClockIcon className="mr-1 inline size-3" aria-hidden />
          {format.timestamp(track.first_seen)} → {format.clock(track.last_seen)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ShareTrack track={track} rssiSamples={rssiSamples} />
        <Button
          variant="outline"
          size="sm"
          disabled={history.length === 0}
          onClick={() => {
            downloadText(`${exportBasename(track)}-path.csv`, 'text/csv', positionsCsv(history))
          }}
        >
          <DownloadIcon aria-hidden />
          CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={history.length === 0}
          onClick={() => {
            downloadText(
              `${exportBasename(track)}-path.geojson`,
              'application/geo+json',
              pathGeoJson(track, history),
            )
          }}
        >
          <DownloadIcon aria-hidden />
          GeoJSON
        </Button>
        {serial ? <AircraftLabelControl serial={serial} /> : null}
      </div>
    </header>
  )
}

/**
 * Six numbers, big.
 *
 * These are the point of the page — what a person recognises a flight by — so
 * they get the treatment the confidence percentage used to have. Every one of
 * them is derived client-side from the same `history` the map draws, which is
 * why a missing receiver position produces a dash here rather than a zero.
 *
 * The strip itself is `MetricStrip` now: Sensors needed the same shape for the
 * same reason, and a second hand-rolled six-column grid would have drifted
 * from this one within a release.
 */
function SummaryStrip({
  track,
  history,
  receiver,
}: {
  track: Track
  history: Position[]
  receiver: ReceiverPosition | null
}) {
  const format = useFormat()
  // Measured against the rebuilt path rather than the track's truncated
  // history: the whole reason the page refetches detections is that the ring
  // buffer loses the start of a long flight, and a maximum taken from the
  // surviving tail would understate every one of these.
  const flown: Track = { ...track, history }
  const duration = flightDurationS(track)
  const range = maxRangeM(flown, receiver)
  const agl = maxHeightAglM(flown)
  const speed = maxSpeedMps(flown)
  const operatorRange =
    track.operator && receiver ? distanceMetres(receiver, track.operator) : null
  const operatorBearing =
    track.operator && receiver ? bearingDegrees(receiver, track.operator) : null

  return (
    <MetricStrip
      label="Flight summary"
      metrics={[
        {
          id: 'duration',
          label: 'Duration',
          value: duration === null ? EMPTY : formatDuration(duration),
          icon: ClockIcon,
        },
        {
          id: 'range',
          label: 'Max range',
          value: format.range(range),
          icon: RouteIcon,
          hint: receiver ? 'from the receiver' : 'set a receiver position',
          tone: receiver ? 'default' : 'muted',
        },
        {
          id: 'agl',
          label: 'Max height AGL',
          value: format.length(agl),
          icon: ArrowUpIcon,
        },
        { id: 'speed', label: 'Max speed', value: format.speed(speed), icon: GaugeIcon },
        {
          id: 'detections',
          label: 'Detections',
          value: track.detection_count,
          icon: RadioIcon,
          hint: `${history.length} path points`,
        },
        {
          id: 'operator',
          label: 'Operator',
          value: operatorRange === null ? EMPTY : format.range(operatorRange),
          icon: UserIcon,
          hint:
            operatorBearing === null
              ? track.operator
                ? 'no receiver position'
                : 'not broadcast'
              : `bearing ${format.heading(operatorBearing)} from the receiver`,
          tone: operatorRange === null ? 'muted' : 'default',
        },
      ]}
    />
  )
}

/**
 * Evidence as one sentence, with the arithmetic behind a disclosure.
 *
 * On a class-A-only track — which is most of them — the breakdown card said
 * "60 %, 1 − (1 − 0.60) = 0.600" on every single flight, occupying the top of
 * the page with a constant. The sentence is what an operator reads; the working
 * is what an auditor opens, and it is still one click away.
 */
function EvidenceLine({ track }: { track: Track }) {
  const format = useFormat()
  const evidence = track.evidence ?? []
  const classes = evidence.map((item) => `Class ${item.class} via ${item.sensor_kind}`)
  const frames = evidence.reduce((sum, item) => sum + item.count, 0)

  return (
    <details className="group">
      <summary className="hover:text-foreground text-muted-foreground flex cursor-pointer list-none items-center gap-2 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        <span>
          {classes.length > 0 ? classes.join(' · ') : 'No evidence recorded'}
          {frames > 0 ? ` · ${frames} frames` : ''} · confidence{' '}
          {format.confidence(track.confidence)}
        </span>
      </summary>
      <div className="mt-2 space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="font-mono text-lg leading-none font-semibold">
            {format.confidence(track.confidence)}
          </span>
          <ConfidenceBar confidence={track.confidence} className="w-32 self-center sm:w-40" />
          <span className="text-muted-foreground text-xs">confidence that this is a drone</span>
        </div>
        <EvidenceBreakdown evidence={evidence} confidence={track.confidence} />
      </div>
    </details>
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

/**
 * An AGL, with a mark on it when fusion derived it rather than the aircraft
 * broadcasting it.
 *
 * A hint line under the value is what the identity panel can afford; a table of
 * hundreds of rows cannot, so the provenance is a superscript and the sentence
 * moves to the title and the legend below the table.
 */
function AglCell({ position }: { position: Position }) {
  const format = useFormat()
  const provenance = heightProvenance(position)

  return (
    <>
      {format.length(position.height_agl_m)}
      {provenance?.source === 'derived' ? (
        <sup
          className="text-muted-foreground ml-0.5 font-sans"
          title={heightProvenanceHint(provenance, format.length)}
        >
          {DERIVED_MARK}
        </sup>
      ) : null}
    </>
  )
}

/**
 * Memoised on purpose. Its props do not change while a replay runs, and its
 * two renderings of up to 500 points are several thousand elements -- React
 * reconciling those ten times a second is most of a frame budget spent on a
 * table nothing is moving.
 */
const PositionHistory = memo(function PositionHistory({
  history,
  track,
}: {
  history: Position[]
  track: Track
}) {
  const format = useFormat()
  // Reversed once, here, instead of separately in each of the two renderings.
  const rows = [...history].reverse().slice(0, HISTORY_ROWS)
  const hidden = history.length - rows.length
  // The legend costs a line, so it only appears once something on screen wears
  // the mark -- and it counts the rendered rows, not the whole path, because a
  // mark the reader cannot see needs no explaining.
  const anyDerived = rows.some((position) => heightProvenance(position)?.source === 'derived')

  return (
    <details className="group">
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
              onClick={() => {
                downloadText(
                  `${exportBasename(track)}-path.csv`,
                  'text/csv',
                  positionsCsv(history),
                )
              }}
            >
              <DownloadIcon aria-hidden />
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                downloadText(
                  `${exportBasename(track)}-path.geojson`,
                  'application/geo+json',
                  pathGeoJson(track, history),
                )
              }}
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
                  className="border-border/60 text-2xs rounded-md border px-2.5 py-2 font-mono"
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
                      <dd>
                        <AglCell position={position} />
                      </dd>
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
                        <AglCell position={position} />
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
        {anyDerived ? (
          <p className="text-muted-foreground text-2xs mt-2 px-1">
            <span className="font-mono">{DERIVED_MARK}</span> height above ground derived from a
            terrain model, not broadcast by the aircraft.
          </p>
        ) : null}
      </div>
    </details>
  )
})
