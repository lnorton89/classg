/**
 * Sweep a band, look at it, compare it with the last one.
 *
 * Operator-initiated rather than a live waterfall, and that is forced rather
 * than chosen: ADR-0008 gives the dongle to dump1090, so a continuously
 * updating view would mean permanent ADS-B blindness. A sweep borrows the
 * radio for one band and gives it back, which costs tens of seconds of no
 * ADS-B — a real cost, so the button says so before it is pressed.
 *
 * Everything here reports ENERGY. A peak above threshold means something is
 * transmitting; it never means a drone.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, ActivityIcon, RadioIcon } from 'lucide-react'
import { useState } from 'react'

import { useFormat } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, EmptyState, Skeleton } from '@/components/ui/misc'
import { Select } from '@/components/ui/select'
import { ApiError, api } from '@/lib/api/client'
import {
  queryKeys,
  spectrumBandsQuery,
  spectrumSweepQuery,
  spectrumSweepsQuery,
} from '@/lib/api/queries'
import { cn } from '@/lib/cn'
import type { SpectrumSweep } from '@/lib/api/types'

import { SpectrumChart } from './spectrum-chart'
import { formatMHz } from './trace-series'

/** Trace width requested from the api. Comfortably more than a chart's pixels. */
const TRACE_BINS = 1400

export function SpectrumPanel() {
  const queryClient = useQueryClient()
  const format = useFormat()

  // Null means "whatever the sensor offers first". Derived rather than synced
  // into state by an effect: the band list arrives asynchronously, and copying
  // it into state means a render where the picker is empty and the Sweep button
  // is disabled for no reason the operator can see.
  const [bandChoice, setBandChoice] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const bands = useQuery(spectrumBandsQuery())
  const sweeps = useQuery(spectrumSweepsQuery())

  const list = sweeps.data?.sweeps ?? []
  const running = list.some((sweep) => sweep.state === 'running')
  const latestComplete = list.find((s) => s.state === 'completed')
  const activeId = selectedId ?? latestComplete?.sweep_id ?? null

  const detail = useQuery({
    ...spectrumSweepQuery(activeId ?? '', TRACE_BINS),
    enabled: activeId !== null,
  })

  // Defaulted from the sensor's own plan rather than a name hardcoded here, so
  // the picker cannot offer a band the binary does not have.
  const band = bandChoice ?? bands.data?.bands[0]?.name ?? ''

  const start = useMutation({
    mutationFn: (name: string) => api.startSweep({ band: name }),
    onSuccess: (sweep) => {
      setSelectedId(sweep.sweep_id)
      void queryClient.invalidateQueries({ queryKey: queryKeys.spectrumSweeps })
      void queryClient.invalidateQueries({ queryKey: queryKeys.spectrumBands })
    },
  })
  const startError = start.error instanceof ApiError ? start.error : null

  const chosen = bands.data?.bands.find((b) => b.name === band)
  const available = bands.data?.available ?? false

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RadioIcon className="size-4" aria-hidden />
            Band sweep
          </CardTitle>
          <CardDescription>
            Measures how much energy is in a band and where. It does not identify anything —
            telling an ELRS control link from a smart meter needs cadence analysis this build
            does not ship.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          {bands.isPending ? (
            <Skeleton className="h-9 w-full" />
          ) : !available ? (
            <Alert tone="warn" title="Sweeping is unavailable on this unit">
              {bands.data?.reason && bands.data.reason.length > 0
                ? bands.data.reason
                : 'The API has no SDR sensor binary configured.'}{' '}
              Everything else keeps working — this is one fewer sensor, not a fault.
            </Alert>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-1">
                  <label htmlFor="sweep-band" className="label-caps mb-1 block">
                    Band
                  </label>
                  <Select
                    id="sweep-band"
                    aria-label="Band to sweep"
                    value={band}
                    onValueChange={setBandChoice}
                    disabled={running || start.isPending}
                    options={(bands.data?.bands ?? []).map((b) => ({
                      value: b.name,
                      label: `${b.name} · ${formatMHz(b.start_hz, 0)}–${formatMHz(b.stop_hz, 0)}`,
                    }))}
                  />
                </div>
                <Button
                  onClick={() => band && start.mutate(band)}
                  disabled={!band || running || start.isPending}
                >
                  <ActivityIcon className="size-4" aria-hidden />
                  {running ? 'Sweeping…' : 'Sweep'}
                </Button>
              </div>

              {chosen ? (
                <p className="text-muted-foreground text-xs leading-relaxed">
                  <span className="text-foreground">{chosen.steps} tune steps.</span>{' '}
                  {chosen.note}
                </p>
              ) : null}

              {/* The cost, stated before it is paid. */}
              <p className="text-muted-foreground flex items-start gap-1.5 text-2xs leading-relaxed">
                <AlertTriangleIcon className="text-warn mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  A sweep takes the radio from <code className="font-mono">dump1090</code> for
                  its duration, so ADS-B stops for as long as it runs. There is one dongle and
                  it cannot do both (ADR-0008).
                </span>
              </p>
            </>
          )}

          {startError ? (
            <Alert
              tone={startError.code === 'conflict' ? 'warn' : 'error'}
              title={
                startError.code === 'conflict'
                  ? 'The radio is busy'
                  : `Could not start the sweep (${startError.code})`
              }
            >
              {startError.message}
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {activeId && detail.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {detail.data.band}
              <SweepStateBadge state={detail.data.state} />
              <span className="text-muted-foreground text-xs font-normal">
                {format.timestamp(detail.data.started_at)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {detail.data.state === 'failed' ? (
              <Alert tone="error" title="This sweep did not complete">
                {detail.data.error && detail.data.error.length > 0
                  ? detail.data.error
                  : 'No reason was recorded.'}
              </Alert>
            ) : detail.data.state === 'running' ? (
              <p className="text-muted-foreground text-xs">
                Measuring. The chart appears when the last step lands.
              </p>
            ) : (
              <SpectrumChart sweep={detail.data} />
            )}
          </CardContent>
        </Card>
      ) : detail.isPending && activeId ? (
        <Skeleton className="h-72 w-full" />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Past sweeps</CardTitle>
          <CardDescription>
            Kept so a band can be compared with itself. &ldquo;Is there something here that was
            not here last week&rdquo; is the question a single sweep cannot answer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sweeps.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : list.length === 0 ? (
            <EmptyState title="No sweeps recorded yet">
              Run one above and it will be kept here.
            </EmptyState>
          ) : (
            <ul className="divide-border/60 divide-y">
              {list.map((sweep) => (
                <SweepRow
                  key={sweep.sweep_id}
                  sweep={sweep}
                  selected={sweep.sweep_id === activeId}
                  onSelect={() => setSelectedId(sweep.sweep_id)}
                  timestamp={format.timestamp}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SweepStateBadge({ state }: { state: SpectrumSweep['state'] }) {
  if (state === 'completed') return <Badge variant="ok">completed</Badge>
  if (state === 'failed') return <Badge variant="down">failed</Badge>
  return <Badge variant="warn">running</Badge>
}

function SweepRow({
  sweep,
  selected,
  onSelect,
  timestamp,
}: {
  sweep: SpectrumSweep
  selected: boolean
  onSelect: () => void
  timestamp: (iso: string) => string
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'hover:bg-muted/50 flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-1 py-2 text-left text-xs',
          selected && 'bg-muted/40',
        )}
      >
        <span className="font-medium">{sweep.band}</span>
        <SweepStateBadge state={sweep.state} />
        <span className="text-muted-foreground">{timestamp(sweep.started_at)}</span>
        <span className="tnum text-muted-foreground ml-auto font-mono">
          {/* Null is rendered as a word, never as a number. A floor of 0 dBFS
              would be a full-scale signal across the whole band. */}
          {typeof sweep.noise_floor_dbfs === 'number'
            ? `floor ${sweep.noise_floor_dbfs.toFixed(1)} dBFS`
            : sweep.state === 'completed'
              ? 'floor unmeasured'
              : ''}
          {typeof sweep.peak_dbfs === 'number'
            ? ` · peak ${sweep.peak_dbfs.toFixed(1)} dBFS`
            : ''}
        </span>
      </button>
    </li>
  )
}
