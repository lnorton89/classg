import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeftIcon, DownloadIcon, PlayIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, DataRow, EmptyState } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { ApiError, api } from '@/lib/api/client'
import { captureQuery, captureReportQuery, queryKeys } from '@/lib/api/queries'
import type { CaptureReport } from '@/lib/api/types'
import { useFormat } from '@/app/use-format'
import { EMPTY } from '@/lib/format'
import { PageContainer } from '@/components/layout/page-container'

export const Route = createFileRoute('/captures/$captureId')({
  component: CaptureDetail,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(captureQuery(params.captureId)),
})

function CaptureDetail() {
  const format = useFormat()
  const { captureId } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: capture } = useQuery(captureQuery(captureId))
  const { data: report, error: reportError } = useQuery(captureReportQuery(captureId))

  const analyze = useMutation({
    mutationFn: () => api.analyzeCapture(captureId),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.captureReport(captureId), result)
      void queryClient.invalidateQueries({ queryKey: queryKeys.captures })
    },
  })

  const notAnalyzed = reportError instanceof ApiError && reportError.isNotFound

  return (
    <PageContainer>
      <div>
        <Link
          to="/sensors"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded text-xs"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden /> Sensors and captures
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-lg font-semibold tracking-tight">
            {capture?.filename ?? captureId}
          </h1>
          {capture ? <Badge variant="muted">{capture.state}</Badge> : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => analyze.mutate()} disabled={analyze.isPending}>
          <PlayIcon aria-hidden />
          {analyze.isPending ? 'Analyzing…' : report ? 'Re-run analysis' : 'Run analysis'}
        </Button>
        {capture?.state === 'completed' ? (
          <a
            href={api.captureDownloadUrl(captureId)}
            download={capture.filename}
            className="border-border bg-background hover:bg-accent inline-flex h-9 items-center gap-2 rounded-md border px-4 text-sm font-medium"
          >
            <DownloadIcon className="size-4" aria-hidden />
            Download .pcap
          </a>
        ) : null}
      </div>

      {analyze.isError ? (
        <Alert tone="error" title="Analysis failed">
          {analyze.error instanceof Error ? analyze.error.message : 'Unknown error'}
        </Alert>
      ) : null}

      {capture ? (
        <Card>
          <CardHeader>
            <CardTitle>Capture</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="sm:grid sm:grid-cols-2 sm:gap-x-8">
              <DataRow label="Interface" value={capture.iface} mono />
              <DataRow label="Channel" value={capture.channel} mono />
              <DataRow label="Duration" value={`${capture.duration_s} s`} mono />
              <DataRow label="Size" value={format.bytes(capture.size_bytes)} mono />
              <DataRow label="Frames" value={capture.frame_count} mono />
              <DataRow
                label={`Started (${format.zoneLabel})`}
                value={format.timestamp(capture.started_at)}
                mono
              />
              <DataRow
                label={`Ended (${format.zoneLabel})`}
                value={format.timestamp(capture.ended_at)}
                mono
              />
              <DataRow label="Capture ID" value={capture.capture_id} mono />
            </dl>
          </CardContent>
        </Card>
      ) : null}

      {notAnalyzed && !report ? (
        <EmptyState title="Not analyzed yet">
          Run the analysis to measure the beacon interval, decode identities and see which
          channel the aircraft actually used.
        </EmptyState>
      ) : null}

      {report ? <ReportView report={report} /> : null}
    </PageContainer>
  )
}

function ReportView({ report }: { report: CaptureReport }) {
  const format = useFormat()
  const totalBeacons = report.channel_usage.reduce((sum, c) => sum + c.beacons, 0)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Frames</CardTitle>
        </CardHeader>
        <CardContent>
          <dl>
            <DataRow label="Frames" value={report.frames} mono />
            <DataRow label="Beacons" value={report.beacons} mono />
            <DataRow label="Transmitters" value={report.transmitters} mono />
            <DataRow
              label="Parse errors"
              value={
                <Tooltip content="A parser that dies on a malformed beacon is a denial-of-service target, so errors are counted rather than fatal.">
                  <span className="underline decoration-dotted">{report.parse_errors}</span>
                </Tooltip>
              }
              mono
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Beacon interval</CardTitle>
        </CardHeader>
        <CardContent>
          {report.beacon_interval ? (
            <>
              <dl>
                <DataRow label="Median" value={`${report.beacon_interval.median_ms} ms`} mono />
                <DataRow
                  label="Range"
                  value={`${report.beacon_interval.min_ms}–${report.beacon_interval.max_ms} ms`}
                  mono
                />
                <DataRow label="Samples" value={report.beacon_interval.samples} mono />
                <DataRow
                  label="Rate"
                  value={`${report.beacon_interval.rate_hz.toFixed(2)} Hz`}
                  mono
                />
              </dl>
              {report.beacon_interval.rate_hz < 0.8 || report.beacon_interval.rate_hz > 1.5 ? (
                <Alert
                  tone="warn"
                  title="The ~1 Hz design assumption looks wrong"
                  className="mt-3"
                >
                  Channel dwell weights in <code>config/channels.yaml</code> are budgeted around
                  a ~1 Hz beacon. Measured {report.beacon_interval.rate_hz.toFixed(2)} Hz —
                  revisit the dwell budget.
                </Alert>
              ) : (
                <p className="text-muted-foreground mt-3 text-xs">
                  Consistent with the ~1 Hz assumption that the channel dwell budget is built
                  on.
                </p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              No drone beacons in this capture, so no interval could be measured.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channel usage</CardTitle>
        </CardHeader>
        <CardContent>
          {report.channel_usage.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No drone beacons seen. Rule out, in order: wrong channel, the drone not
              broadcasting Wi-Fi Remote ID (some models are Bluetooth-only), or distance.
            </p>
          ) : (
            <ul className="space-y-2">
              {report.channel_usage.map((entry) => (
                <li key={entry.channel} className="flex items-center gap-2">
                  <span className="w-14 font-mono text-xs">ch {entry.channel}</span>
                  <span className="bg-muted relative h-2 flex-1 overflow-hidden rounded-full">
                    <span
                      className="bg-track absolute inset-y-0 left-0 rounded-full"
                      style={{
                        width: `${totalBeacons ? (entry.beacons / totalBeacons) * 100 : 0}%`,
                      }}
                    />
                  </span>
                  <span className="w-14 text-right font-mono text-xs">{entry.beacons}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decoded identities ({report.identities.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {report.identities.length === 0 ? (
            <p className="text-muted-foreground text-xs">No drone transmitters decoded.</p>
          ) : (
            <ul className="space-y-3">
              {report.identities.map((identity) => (
                <li key={identity.mac} className="border-border rounded-md border p-3">
                  <dl>
                    <DataRow label="MAC" value={identity.mac} mono />
                    <DataRow label="Serial" value={identity.serial ?? EMPTY} mono />
                    <DataRow
                      label="Manufacturer code"
                      value={
                        identity.manufacturer_code ? (
                          <Tooltip content="ANSI/CTA-2063-A code from the serial. Survives MAC randomisation, unlike an OUI.">
                            <span className="underline decoration-dotted">
                              {identity.manufacturer_code}
                              {identity.vendor ? ` (${identity.vendor})` : ''}
                            </span>
                          </Tooltip>
                        ) : (
                          EMPTY
                        )
                      }
                      mono
                    />
                    <DataRow label="ID type" value={identity.id_type ?? EMPTY} mono />
                    <DataRow label="UA type" value={identity.ua_type ?? EMPTY} mono />
                    <DataRow
                      label="Protocol version"
                      value={identity.protocol_version ?? EMPTY}
                      mono
                    />
                    <DataRow
                      label="Beacons"
                      value={`ODID ${identity.odid_count} · DJI ${identity.dji_count}`}
                      mono
                    />
                    <DataRow
                      label="Channels"
                      value={identity.channels.join(', ') || EMPTY}
                      mono
                    />
                    <DataRow
                      label="RSSI"
                      value={`${format.rssi(identity.rssi_min_dbm)} – ${format.rssi(
                        identity.rssi_max_dbm,
                      )} (median ${format.rssi(identity.rssi_median_dbm)})`}
                      mono
                    />
                    <DataRow
                      label="Operator location"
                      value={
                        identity.operator_location_broadcast ? (
                          <span className="text-operator">broadcast</span>
                        ) : (
                          'not broadcast'
                        )
                      }
                    />
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>DJI field calibration</CardTitle>
        </CardHeader>
        <CardContent>
          {report.dji_calibration.length === 0 ? (
            <Alert tone="info" title="No DJI vendor IE in this capture">
              For a Mini 5 Pro this is the <em>expected</em> result, not a bug: standards Remote
              ID goes out over Wi-Fi Beacon while DJI&apos;s proprietary DroneID rides OcuSync
              at 2.4/5.8 GHz, out of reach of both radios. The <code>SCALES</code> constants in{' '}
              <code>parsers/dji.py</code> stay unvalidated until a DJI Wi-Fi-mode drone is
              available.
            </Alert>
          ) : (
            <>
              <p className="text-muted-foreground mb-2 text-xs">
                Compare each raw value against what the DJI app showed at capture time, then
                record the result in <code>docs/ops/04-calibration.md</code>. Until then, treat
                every DJI altitude, height, velocity and attitude value as unverified.
              </p>
              {/* Four columns of numbers in about 30rem, which a phone does
                  not have. Stacked below sm rather than scrolled sideways --
                  this is a calibration worksheet somebody reads value by
                  value, and a column hidden off the right edge is a value
                  they will not check. */}
              <ul className="space-y-2 sm:hidden">
                {report.dji_calibration.map((row) => (
                  <li
                    key={row.field}
                    className="border-border/60 rounded-md border px-2.5 py-2 font-mono text-2xs"
                  >
                    <p className="text-foreground font-sans text-xs font-medium">{row.field}</p>
                    <dl className="tnum mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      <dt className="text-muted-foreground font-sans">raw</dt>
                      <dd>{row.raw ?? EMPTY}</dd>
                      <dt className="text-muted-foreground font-sans">decoded</dt>
                      <dd>{row.decoded === null ? EMPTY : `${row.decoded} ${row.unit}`}</dd>
                      <dt className="text-muted-foreground font-sans">scale</dt>
                      <dd>{row.scale}</dd>
                    </dl>
                  </li>
                ))}
              </ul>

              <div className="hidden sm:block">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="border-border border-b">
                      <th scope="col" className="py-1.5 pr-3 font-medium">
                        Field
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                        Raw
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                        Decoded
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Scale
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y font-mono">
                    {report.dji_calibration.map((row) => (
                      <tr key={row.field}>
                        <td className="py-1.5 pr-3">{row.field}</td>
                        <td className="py-1.5 pr-3 text-right">{row.raw ?? EMPTY}</td>
                        <td className="py-1.5 pr-3 text-right">
                          {row.decoded === null ? EMPTY : `${row.decoded} ${row.unit}`}
                        </td>
                        <td className="py-1.5 text-right">{row.scale}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
