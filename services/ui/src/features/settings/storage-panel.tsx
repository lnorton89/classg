/**
 * Storage: how full, how fast, and how far back history actually goes.
 *
 * The second question an operator asks after "is it recording", and until now
 * the answer was spread across three places — free bytes on the About card,
 * retention durations buried in the settings table, and nothing at all about
 * the rate. A recorder puts them on one screen because they are one question.
 *
 * Three things here refuse to be confidently wrong:
 *
 * A host figure that could not be read is "unavailable" with its reason, never
 * a zero — the same rule /system already follows. A disk drawn as empty
 * because statfs failed inside a container is the worst possible failure here.
 *
 * The time-to-full forecast returns "cannot say" as a real outcome. A
 * least-squares fit always produces a number, including through a flat series
 * or one that is rising because the purge job just ran, and "full in 3 days"
 * from noise is a date somebody will plan around. storage-forecast.ts holds
 * the arithmetic and the tests.
 *
 * Retention is shown as the horizon it is: rows older than it are gone, which
 * is why an empty stretch on the Timeline is not necessarily a quiet sky.
 */
import { useQuery } from '@tanstack/react-query'
import { HardDriveIcon, TrendingDownIcon } from 'lucide-react'

import { useFormat } from '@/app/use-format'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, Skeleton } from '@/components/ui/misc'
import { capturesQuery, settingsQuery, systemQuery, telemetryQuery } from '@/lib/api/queries'
import { cn } from '@/lib/cn'

import { forecastDiskFull, usedFraction } from './storage-forecast'
import type { ForecastVerdict } from './storage-forecast'

/** The retention settings, in the order an operator cares about them. */
const RETENTION_KEYS: { key: string; label: string; note: string }[] = [
  {
    key: 'retention.detections',
    label: 'Detections',
    note: 'Raw sensor observations. The bulk of the database by a wide margin.',
  },
  {
    key: 'retention.tracks',
    label: 'Tracks',
    note: 'Fused tracks and their history. What the Timeline draws.',
  },
  {
    key: 'retention.telemetry',
    label: 'Telemetry',
    note: 'Host and sensor samples. What the charts on this page are fitted to.',
  },
  {
    key: 'retention.sweeps',
    label: 'Spectrum sweeps',
    note: 'Stored measurements, bins included.',
  },
  {
    key: 'retention.hook_deliveries',
    label: 'Hook deliveries',
    note: 'The delivery log for outbound hooks.',
  },
]

export function StoragePanel() {
  const format = useFormat()
  const system = useQuery(systemQuery())
  // A week, because a forecast fitted to an hour of a Pi is fitted to noise.
  const telemetry = useQuery(telemetryQuery('168h'))
  const settings = useQuery(settingsQuery())
  const captures = useQuery(capturesQuery())

  const host = system.data?.host
  const used = usedFraction(host?.disk_total_bytes, host?.disk_free_bytes)
  const forecast = forecastDiskFull(
    (telemetry.data?.samples ?? []).map((s) => ({
      ts: Date.parse(s.ts),
      free: s.disk_free_bytes,
    })),
  )

  const captureBytes = (captures.data?.captures ?? []).reduce(
    (sum, c) => sum + (c.size_bytes || 0),
    0,
  )

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDriveIcon className="size-4" aria-hidden />
            Disk
          </CardTitle>
          <CardDescription>
            The filesystem detections actually land on — {host?.disk_path ?? 'unknown'} — not
            the container&rsquo;s root, which fills at a different rate and is not what anyone
            is asking about.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {system.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : used === null ? (
            <Alert tone="info" title="Disk usage is not readable here">
              {host?.unavailable?.disk_free_bytes ??
                'The API could not stat this filesystem. On a containerised deployment that is expected; the figure is readable on the Pi itself.'}
            </Alert>
          ) : (
            <>
              <div
                className="bg-muted h-3 w-full overflow-hidden rounded-full"
                role="img"
                aria-label={`Disk ${(used * 100).toFixed(0)} percent used`}
              >
                <div
                  className={cn(
                    'h-full rounded-full',
                    used > 0.9 ? 'bg-down' : used > 0.75 ? 'bg-warn' : 'bg-ok',
                  )}
                  style={{ width: `${used * 100}%` }}
                />
              </div>
              <dl className="tnum grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                <Figure label="Used" value={`${(used * 100).toFixed(1)}%`} />
                <Figure label="Free" value={format.bytes(host?.disk_free_bytes ?? 0)} />
                <Figure label="Total" value={format.bytes(host?.disk_total_bytes ?? 0)} />
              </dl>
            </>
          )}

          <ForecastLine verdict={forecast} bytes={format.bytes} pending={telemetry.isPending} />

          {captures.data ? (
            <p className="text-muted-foreground text-2xs leading-relaxed">
              Captures account for {format.bytes(captureBytes)} of that across{' '}
              {captures.data.captures.length} file
              {captures.data.captures.length === 1 ? '' : 's'}. They are the one thing here with
              no retention policy — a PCAP is deleted when somebody deletes it.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retention</CardTitle>
          <CardDescription>
            How far back each kind of record is kept. Anything older is deleted by the retention
            job, which is why an empty stretch at the left edge of a long Timeline window may be
            purged history rather than a quiet sky.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <dl className="divide-border/60 divide-y text-xs">
              {RETENTION_KEYS.map(({ key, label, note }) => {
                const value = settings.data?.settings[key]?.value
                return (
                  <div
                    key={key}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
                  >
                    <dt className="font-medium">{label}</dt>
                    <dd className="tnum font-mono">
                      {typeof value === 'string' && value.length > 0 ? (
                        value
                      ) : (
                        <span className="text-muted-foreground font-sans">not set</span>
                      )}
                    </dd>
                    <p className="text-muted-foreground w-full text-2xs leading-snug">{note}</p>
                  </div>
                )
              })}
            </dl>
          )}
        </CardContent>
      </Card>
    </>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label-caps">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  )
}

function ForecastLine({
  verdict,
  bytes,
  pending,
}: {
  verdict: ForecastVerdict
  bytes: (n: number) => string
  pending: boolean
}) {
  if (pending) return <Skeleton className="h-4 w-64" />

  if (verdict.kind === 'unknown') {
    return (
      <p className="text-muted-foreground text-2xs leading-relaxed">
        No fill rate yet — {verdict.reason}. A projection from less than this would be a fit
        through noise, and a confident wrong date is worse than none.
      </p>
    )
  }

  if (verdict.kind === 'stable') {
    return (
      <p className="text-muted-foreground text-2xs leading-relaxed">
        Free space is steady over the last week
        {verdict.bytesPerDay > 0 ? ' and recovering' : ''} — retention is keeping up with what
        the sensors write. Nothing to project.
      </p>
    )
  }

  const days = verdict.daysRemaining
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-2xs leading-relaxed',
        days < 14 ? 'text-warn' : 'text-muted-foreground',
      )}
    >
      <TrendingDownIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        Filling at about {bytes(Math.abs(verdict.bytesPerDay))} a day — roughly{' '}
        <span className="text-foreground font-medium">
          {days < 1 ? 'less than a day' : `${Math.round(days)} days`}
        </span>{' '}
        of headroom at that rate. A straight line through the last week, so a change in traffic
        or a retention edit moves it.
      </span>
    </p>
  )
}
