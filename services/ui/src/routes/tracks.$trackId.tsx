import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeftIcon, UserIcon } from 'lucide-react'

import { Alert, DataRow, EmptyState } from '@/components/ui/misc'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { bearingDegrees, distanceMetres } from '@/features/map/geo'
import { ConfidenceBar, EvidenceBreakdown, TrackStateBadge } from '@/features/tracks/evidence'
import { RssiChart, samplesFromDetections } from '@/features/tracks/rssi-chart'
import { ApiError } from '@/lib/api/client'
import { trackDetectionsQuery, trackQuery } from '@/lib/api/queries'
import {
  EMPTY,
  formatClock,
  formatConfidence,
  formatHeading,
  formatLatLon,
  formatMetres,
  formatRelative,
  formatRssi,
  formatSpeed,
  formatTimestamp,
  splitSerial,
} from '@/lib/format'

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
        Tracks are held in memory only and are dropped 300 seconds after they close, so this one
        may simply have expired. Track state is deliberately not persisted — stale tracks are
        worse than no tracks.
      </Alert>
    </div>
  ),
})

function TrackDetail() {
  const { trackId } = Route.useParams()
  const { data: track } = useQuery(trackQuery(trackId))
  const { data: detectionsData } = useQuery(trackDetectionsQuery(trackId))

  if (!track) return null

  const detections = detectionsData?.detections ?? []
  const rssiSamples = samplesFromDetections(detections)
  const serial = splitSerial(track.identity?.serial)
  const current = track.current
  const operator = track.operator
  const history = track.history ?? []

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 sm:p-4">
      <div>
        <Link
          to="/tracks"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded text-xs"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden /> All tracks
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-lg font-semibold tracking-tight">
            {track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id}
          </h1>
          <TrackStateBadge state={track.state} />
          {track.adsb_correlated ? (
            <Tooltip content="Correlated with an ADS-B contact. Fusion uses this to suppress energy-only false positives; it never suppresses a decoded Remote ID.">
              <Badge variant="warn">ADS-B correlated</Badge>
            </Tooltip>
          ) : null}
        </div>
        <p className="text-muted-foreground mt-1 font-mono text-[11px]">{track.track_id}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---- Why this is a detection. First, and widest. ---- */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Why this is a detection</CardTitle>
            <div className="mt-1 flex items-center gap-3">
              <ConfidenceBar confidence={track.confidence} className="w-32" />
              <span className="font-mono text-sm font-semibold">
                {formatConfidence(track.confidence)}
              </span>
              <span className="text-muted-foreground text-xs">
                confidence that this is a drone
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <EvidenceBreakdown evidence={track.evidence ?? []} confidence={track.confidence} />
          </CardContent>
        </Card>

        {/* ---- Identity ---- */}
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
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
                        <span key={mac}>{mac}</span>
                      ))}
                    </span>
                  ) : (
                    EMPTY
                  )
                }
              />
              <DataRow label="Detections" value={track.detection_count} mono />
              <DataRow label="First seen" value={formatTimestamp(track.first_seen)} mono />
              <DataRow
                label="Last seen"
                value={`${formatTimestamp(track.last_seen)} (${formatRelative(track.last_seen)})`}
                mono
              />
            </dl>
          </CardContent>
        </Card>

        {/* ---- Position ---- */}
        <Card>
          <CardHeader>
            <CardTitle>Current position</CardTitle>
          </CardHeader>
          <CardContent>
            {current ? (
              <dl>
                <DataRow
                  label="Latitude, longitude"
                  value={formatLatLon(current.lat, current.lon)}
                  mono
                />
                <DataRow
                  label="Geodetic altitude"
                  value={formatMetres(current.alt_geodetic_m)}
                  mono
                />
                <DataRow
                  label="Height AGL"
                  value={
                    <Tooltip content="Some aircraft report height above the takeoff point rather than above ground level. The Mini 5 Pro does; see docs/ops/04-calibration.md.">
                      <span className="underline decoration-dotted">
                        {formatMetres(current.height_agl_m)}
                      </span>
                    </Tooltip>
                  }
                  mono
                />
                <DataRow label="Ground speed" value={formatSpeed(current.speed_mps)} mono />
                <DataRow label="Track" value={formatHeading(current.track_deg)} mono />
                <DataRow label="Reported at" value={formatClock(current.at)} mono />
              </dl>
            ) : (
              <EmptyState title="No position reported">
                This track has identity evidence but no GPS fix, so it cannot be plotted.
                Coordinates of exactly 0,0 are normalised to absent rather than shown as the
                Gulf of Guinea.
              </EmptyState>
            )}
          </CardContent>
        </Card>

        {/* ---- Operator ---- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserIcon className="text-operator size-4" aria-hidden />
              Operator position
            </CardTitle>
          </CardHeader>
          <CardContent>
            {operator ? (
              <dl>
                <DataRow
                  label="Latitude, longitude"
                  value={formatLatLon(operator.lat, operator.lon)}
                  mono
                />
                <DataRow label="Altitude" value={formatMetres(operator.alt_geodetic_m)} mono />
                {current ? (
                  <>
                    <DataRow
                      label="Distance from aircraft"
                      value={`${Math.round(distanceMetres(current, operator))} m`}
                      mono
                    />
                    <DataRow
                      label="Bearing from aircraft"
                      value={formatHeading(bearingDegrees(current, operator))}
                      mono
                    />
                  </>
                ) : null}
                <DataRow label="Reported at" value={formatClock(operator.at)} mono />
              </dl>
            ) : (
              <p className="text-muted-foreground text-xs">
                Not broadcast. Operator position comes from an ASTM F3411 System message or DJI
                DroneID <code>0x10</code>; plenty of tracks never carry one. This is a normal
                state, not an error.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ---- RSSI ---- */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Signal strength over time</CardTitle>
          </CardHeader>
          <CardContent>
            <RssiChart samples={rssiSamples} />
          </CardContent>
        </Card>

        {/* ---- Position history ---- */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Position history ({history.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-muted-foreground text-xs">No position history.</p>
            ) : (
              <div className="max-h-80 overflow-auto">
                <table className="w-full min-w-[36rem] text-left text-xs">
                  <thead className="text-muted-foreground bg-card sticky top-0">
                    <tr className="border-border border-b">
                      <th scope="col" className="py-1.5 pr-3 font-medium">
                        Time
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-medium">
                        Latitude, longitude
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                        AGL
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                        Geodetic
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                        Speed
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Track
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y font-mono">
                    {[...history].reverse().map((position, index) => (
                      <tr key={`${position.at ?? index}-${position.lat}`}>
                        <td className="py-1 pr-3">{formatClock(position.at)}</td>
                        <td className="py-1 pr-3">
                          {formatLatLon(position.lat, position.lon)}
                        </td>
                        <td className="py-1 pr-3 text-right">
                          {formatMetres(position.height_agl_m)}
                        </td>
                        <td className="py-1 pr-3 text-right">
                          {formatMetres(position.alt_geodetic_m)}
                        </td>
                        <td className="py-1 pr-3 text-right">
                          {formatSpeed(position.speed_mps)}
                        </td>
                        <td className="py-1 text-right">{formatHeading(position.track_deg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-muted-foreground text-[11px]">
        Peak RSSI{' '}
        {formatRssi(rssiSamples.length ? Math.max(...rssiSamples.map((s) => s.rssi)) : null)}
        {' · '}
        {detections.length} detections loaded for this track.
      </p>
    </div>
  )
}
