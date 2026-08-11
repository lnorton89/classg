import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeftIcon, ChevronRightIcon, HistoryIcon, UserIcon } from 'lucide-react'

import { useFormat, useTicker } from '@/app/use-format'
import { CopyButton } from '@/components/ui/copy-button'
import { Alert, DataRow, EmptyState } from '@/components/ui/misc'
import { Badge } from '@/components/ui/badge'
import { Tooltip } from '@/components/ui/tooltip'
import { bearingDegrees, distanceMetres } from '@/features/map/geo'
import { TrackMap } from '@/features/map/track-map'
import { ConfidenceBar, EvidenceBreakdown, TrackStateBadge } from '@/features/tracks/evidence'
import { RssiChart, samplesFromDetections } from '@/features/tracks/rssi-chart'
import {
  SortableTrackDetailGrid,
  type TrackDetailCard,
} from '@/features/tracks/sortable-detail-grid'
import { ApiError } from '@/lib/api/client'
import { trackDetectionsQuery, trackQuery } from '@/lib/api/queries'
import type { Position } from '@/lib/api/types'
import { EMPTY } from '@/lib/format'
import { PageContainer } from '@/components/layout/page-container'

export const Route = createFileRoute('/tracks/$trackId')({
  component: TrackDetail,
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(trackQuery(params.trackId))
    } catch (error) {
      if (error instanceof ApiError && error.isNotFound) return notFound()
      throw error instanceof Error ? error : new Error(String(error))
    }
  },
  notFoundComponent: () => (
    <div className="p-6">
      <Alert tone="info" title="Track not found">
        This track is not in the configured store. Closed tracks remain available until the
        retention window removes them; the memory store also resets whenever the API restarts.
      </Alert>
    </div>
  ),
})

function TrackDetail() {
  const { trackId } = Route.useParams()
  const { data: track } = useQuery(trackQuery(trackId))
  const { data: detectionsData } = useQuery(trackDetectionsQuery(trackId))
  const format = useFormat()
  useTicker(5000)

  if (!track) return null

  const detections = detectionsData?.detections ?? []
  const rssiSamples = samplesFromDetections(detections)
  const serial = format.splitSerial(track.identity?.serial)
  const current = track.current
  const operator = track.operator
  const history = track.history ?? []
  const peakRssi = format.rssi(
    rssiSamples.length ? Math.max(...rssiSamples.map((sample) => sample.rssi)) : null,
  )

  const cards: TrackDetailCard[] = [
    {
      id: 'evidence',
      label: 'Detection evidence',
      title: 'Why this is a detection',
      className: 'md:col-span-2',
      headerExtra: (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <ConfidenceBar confidence={track.confidence} className="w-32 sm:w-40" />
          <span className="font-mono text-base font-semibold">
            {format.confidence(track.confidence)}
          </span>
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
      title: 'Identity',
      content: (
        <dl className="space-y-0.5">
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
          <DataRow label="Vendor" value={track.identity?.vendor ?? EMPTY} />
          <DataRow label="Model hint" value={track.identity?.model_hint ?? EMPTY} />
          <DataRow label="UA type" value={track.identity?.ua_type ?? EMPTY} />
          <DataRow label="Operator ID" value={track.identity?.operator_id ?? EMPTY} mono />
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
          <DataRow label="Detections" value={track.detection_count} mono />
          <DataRow
            label={`First seen (${format.zoneLabel})`}
            value={format.timestamp(track.first_seen)}
            mono
          />
          <DataRow
            label={`Last seen (${format.zoneLabel})`}
            value={`${format.timestamp(track.last_seen)} (${format.relative(track.last_seen)})`}
            mono
          />
        </dl>
      ),
    },
    {
      id: 'flight',
      label: 'Flight path',
      title: 'Flight path',
      description:
        'Latest aircraft position, reported route, and operator ground position when available.',
      className: 'md:col-span-2 xl:col-span-3',
      contentClassName: 'p-0 pt-0',
      content: (
        <>
          <TrackMap track={track} />
          <PositionHistory history={history} />
        </>
      ),
    },
    {
      id: 'position',
      label: 'Current position',
      title: 'Current position',
      content: current ? (
        <dl className="space-y-0.5">
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
          <DataRow label="Ground speed" value={format.speed(current.speed_mps)} mono />
          <DataRow label="Track" value={format.heading(current.track_deg)} mono />
          <DataRow
            label={`Reported at (${format.zoneLabel})`}
            value={format.clock(current.at)}
            mono
          />
        </dl>
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
      title: (
        <span className="flex items-center gap-2">
          <UserIcon className="text-operator size-4" aria-hidden />
          Operator position
        </span>
      ),
      content: operator ? (
        <dl className="space-y-0.5">
          <DataRow
            label="Latitude, longitude"
            value={format.coords(operator.lat, operator.lon)}
            mono
          />
          <DataRow label="Altitude" value={format.length(operator.alt_geodetic_m)} mono />
          {current ? (
            <>
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
            </>
          ) : null}
          <DataRow
            label={`Reported at (${format.zoneLabel})`}
            value={format.clock(operator.at)}
            mono
          />
        </dl>
      ) : (
        <p className="text-muted-foreground text-sm leading-relaxed">
          Not broadcast. Operator position comes from an ASTM F3411 System message or DJI
          DroneID <code>0x10</code>; many tracks never carry one. This is a normal state, not an
          error.
        </p>
      ),
    },
    {
      id: 'signal',
      label: 'Signal strength',
      title: 'Signal strength over time',
      description: `${rssiSamples.length} RSSI samples · peak ${peakRssi}`,
      content: <RssiChart samples={rssiSamples} height={160} />,
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
      </header>

      <SortableTrackDetailGrid cards={cards} />
    </PageContainer>
  )
}

function PositionHistory({ history }: { history: Position[] }) {
  const format = useFormat()

  return (
    <details className="group border-border border-t">
      <summary className="hover:bg-accent/30 focus-visible:ring-ring flex cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        <HistoryIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="font-medium">Position history</span>
        <span className="text-muted-foreground text-xs">{history.length} reported points</span>
        <span className="text-muted-foreground ml-auto hidden text-xs sm:inline">
          Collapsed by default
        </span>
      </summary>

      <div className="border-border bg-muted/10 border-t p-3">
        {history.length === 0 ? (
          <p className="text-muted-foreground px-1 py-3 text-sm">No position history.</p>
        ) : (
          <div className="max-h-80 overflow-auto [scrollbar-gutter:stable_both-edges]">
            <div className="min-w-[42rem] pr-3 pb-3">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Reported aircraft position history</caption>
                <thead className="text-muted-foreground bg-card sticky top-0 z-10">
                  <tr className="border-border border-b">
                    <th scope="col" className="py-2 pr-4 font-medium">
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
                    <th scope="col" className="py-2 pr-1 text-right font-medium">
                      Track
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y font-mono">
                  {[...history].reverse().map((position, index) => (
                    <tr key={`${position.at ?? index}-${position.lat}`}>
                      <td className="py-1.5 pr-4">{format.clock(position.at)}</td>
                      <td className="py-1.5 pr-4">
                        {format.coords(position.lat, position.lon)}
                      </td>
                      <td className="py-1.5 pr-4 text-right">
                        {format.length(position.height_agl_m)}
                      </td>
                      <td className="py-1.5 pr-4 text-right">
                        {format.length(position.alt_geodetic_m)}
                      </td>
                      <td className="py-1.5 pr-4 text-right">
                        {format.speed(position.speed_mps)}
                      </td>
                      <td className="py-1.5 pr-1 text-right">
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
