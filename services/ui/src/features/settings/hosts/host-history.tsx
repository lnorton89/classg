/**
 * "And how has it been?" — recorded host history under the Host card's
 * instantaneous readings.
 *
 * Hand-rolled SVG sparklines, one figure per chart, following the RssiChart
 * precedent: a charting library would be the largest dependency in the bundle
 * for a box that serves this over its own Wi-Fi AP. Four stacked single-series
 * charts sharing one time axis and one window control — never two scales on
 * one plot.
 *
 * The rule that shapes the drawing: a null reading is a GAP. The line breaks,
 * full stop. A point at zero or a line interpolated across the hole would put
 * fabricated data in the same ink as measurements — 0 °C and 0 bytes free are
 * both plausible, which is what makes them lies. The split lives in
 * telemetry-series.ts where plain unit tests pin it.
 */
import { AlertTriangleIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useFormat, type Formatters } from '@/app/use-format'
import { AccessibleChartTable } from '@/components/ui/accessible-chart-table'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/misc'
import { cn } from '@/lib/cn'
import type { TelemetryResponse, TelemetrySample } from '@/lib/api/types'

import {
  downsampleSegment,
  nearestSampleIndex,
  seriesExtent,
  splitSegments,
  type TelemetryPoint,
} from './telemetry-series'

/** The windows on offer. Values are what the API's `window` parameter takes. */
export type TelemetryWindow = '1h' | '6h' | '24h' | '168h'

const WINDOW_OPTIONS: { value: TelemetryWindow; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '168h', label: '7d' },
]

interface HostMetric {
  key: string
  label: string
  pick: (sample: TelemetrySample) => number | null
  fmt: (value: number) => string
}

function hostMetrics(format: Formatters): HostMetric[] {
  return [
    {
      key: 'cpu_temp_c',
      label: 'CPU temperature',
      pick: (s) => s.cpu_temp_c,
      fmt: (v) => `${v.toFixed(1)} °C`,
    },
    {
      key: 'load1',
      label: 'Load (1 min)',
      pick: (s) => s.load1,
      fmt: (v) => v.toFixed(2),
    },
    {
      key: 'mem_available_kb',
      label: 'Memory available',
      pick: (s) => s.mem_available_kb,
      fmt: (v) => format.bytes(v * 1024),
    },
    {
      key: 'disk_free_bytes',
      label: 'Disk free',
      pick: (s) => s.disk_free_bytes,
      fmt: (v) => format.bytes(v),
    },
  ]
}

/** SVG viewBox. Stretched to fit; strokes stay 2px via non-scaling-stroke. */
const VIEW_W = 480
const VIEW_H = 32
const PAD_Y = 3
/** Per-segment draw budget. 5000-sample windows thin to this many points. */
const MAX_DRAW_POINTS = 700

export function HostHistory({
  data,
  isPending,
  isRefreshing,
  isError,
  window: windowValue,
  onWindowChange,
}: {
  data: TelemetryResponse | undefined
  isPending: boolean
  /** Previous window's data is on screen while the new one loads. */
  isRefreshing: boolean
  isError: boolean
  window: TelemetryWindow
  onWindowChange: (window: TelemetryWindow) => void
}) {
  const format = useFormat()
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const metrics = useMemo(() => hostMetrics(format), [format])
  const samples = useMemo(() => data?.samples ?? [], [data])

  // The x-domain is what the axis CLAIMS, so it must never exceed what the data
  // covers: when the response is truncated the window held more than one
  // response carries, and the axis ends at the last returned sample instead of
  // pretending to show the full window. The note below says why.
  const lastSample = samples[samples.length - 1]
  const domain = useMemo(() => {
    if (!data) return null
    const start = Date.parse(data.since)
    const end =
      data.truncated && lastSample ? Date.parse(lastSample.ts) : Date.parse(data.until)
    return { start, end: Math.max(end, start + 1) }
  }, [data, lastSample])

  const series = useMemo(
    () =>
      metrics.map((metric) => {
        const segments = splitSegments(samples, metric.pick)
        return {
          metric,
          segments,
          extent: seriesExtent(segments),
          unavailableCount: samples.reduce(
            (n, sample) => (metric.pick(sample) === null ? n + 1 : n),
            0,
          ),
        }
      }),
    [metrics, samples],
  )

  const hovered = hoverIndex !== null ? samples[hoverIndex] : undefined
  const hoverT = hovered ? Date.parse(hovered.ts) : null
  const hoverPct =
    domain && hoverT !== null
      ? Math.min(
          100,
          Math.max(0, ((hoverT - domain.start) / (domain.end - domain.start)) * 100),
        )
      : null

  // Clock alone is ambiguous once the axis spans more than a day.
  const spansDays = domain !== null && domain.end - domain.start > 24 * 3600 * 1000
  const axisLabel = (t: number) =>
    spansDays
      ? format.timestamp(new Date(t).toISOString())
      : format.clock(new Date(t).toISOString())

  return (
    <div className="border-border/60 mt-4 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="label-caps">History</p>
        <Segmented
          value={windowValue}
          onValueChange={onWindowChange}
          options={WINDOW_OPTIONS}
          aria-label="History window"
          className="p-0.5 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-xs"
        />
      </div>

      {isError ? (
        <p className="text-muted-foreground mt-3 text-xs">
          History is unavailable — the api did not answer{' '}
          <code className="font-mono text-xs">/telemetry</code>. The instantaneous readings
          above are unaffected.
        </p>
      ) : isPending ? (
        <div className="mt-3 space-y-3">
          {metrics.map((metric) => (
            <Skeleton key={metric.key} className="h-12 w-full" />
          ))}
        </div>
      ) : samples.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-xs">
          No history recorded in this window yet. The receiver writes one sample a minute;
          charts appear as soon as there is something to draw.
        </p>
      ) : domain ? (
        <div
          className={cn('mt-3 transition-opacity', isRefreshing && 'opacity-60')}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <div className="space-y-3">
            {series.map(({ metric, segments, extent, unavailableCount }) => (
              <MetricRow
                key={metric.key}
                metric={metric}
                segments={segments}
                extent={extent}
                unavailableCount={unavailableCount}
                sampleCount={samples.length}
                domain={domain}
                hovered={hovered}
                hoverPct={hoverPct}
                clock={format.clock}
                onHover={(t) => setHoverIndex(nearestSampleIndex(samples, t))}
              />
            ))}
          </div>

          <div className="text-muted-foreground tnum mt-1.5 flex items-baseline justify-between gap-4 text-2xs">
            <span>{axisLabel(domain.start)}</span>
            <span>{axisLabel(domain.end)}</span>
          </div>

          {data?.truncated ? (
            <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-2xs leading-relaxed">
              <AlertTriangleIcon className="text-warn mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                This window holds more history than the api returns in one response (5,000
                samples), so the charts stop at {axisLabel(domain.end)} rather than covering the
                whole window. Pick a shorter window for the recent end.
              </span>
            </p>
          ) : null}

          {/* The accessible twin of the plots: same rows, as a table. Lazy: a
              5,000-sample window should not render its body until asked. */}
          <AccessibleChartTable
            className="mt-2"
            summary="Show history as a table"
            lazy
            rows={samples}
            rowKey={(sample) => sample.ts}
            columns={[
              {
                key: 'time',
                label: `Time (${format.zoneLabel})`,
                render: (sample) =>
                  spansDays ? format.timestamp(sample.ts) : format.clock(sample.ts),
              },
              ...metrics.map((metric) => ({
                key: metric.key,
                label: metric.label,
                render: (sample: TelemetrySample) => {
                  const value = metric.pick(sample)
                  return value === null ? (
                    <span className="text-muted-foreground font-sans">Unavailable</span>
                  ) : (
                    metric.fmt(value)
                  )
                },
              })),
            ]}
          />
        </div>
      ) : null}
    </div>
  )
}

function MetricRow({
  metric,
  segments,
  extent,
  unavailableCount,
  sampleCount,
  domain,
  hovered,
  hoverPct,
  clock,
  onHover,
}: {
  metric: HostMetric
  segments: TelemetryPoint[][]
  extent: { min: number; max: number } | null
  unavailableCount: number
  sampleCount: number
  domain: { start: number; end: number }
  hovered: TelemetrySample | undefined
  hoverPct: number | null
  clock: Formatters['clock']
  onHover: (t: number) => void
}) {
  const hoverValue = hovered ? metric.pick(hovered) : undefined

  if (!extent) {
    // The whole window failed to read. Say the word, exactly as the row above
    // does for the instantaneous value — an empty strip would read as "no
    // load", which is a claim.
    return (
      <div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-muted-foreground text-xs">{metric.label}</span>
          <span className="text-muted-foreground text-xs">Unavailable for this window</span>
        </div>
      </div>
    )
  }

  // Pad the value range so the line never kisses the strip's edges; a flat
  // series gets an artificial band so it draws mid-strip instead of on a rail.
  const spread = extent.max - extent.min
  const pad = spread > 0 ? spread * 0.1 : Math.max(Math.abs(extent.max) * 0.05, 0.5)
  const vMin = extent.min - pad
  const vMax = extent.max + pad
  const x = (t: number) => ((t - domain.start) / (domain.end - domain.start)) * VIEW_W
  const y = (v: number) => PAD_Y + (1 - (v - vMin) / (vMax - vMin)) * (VIEW_H - 2 * PAD_Y)

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-muted-foreground text-xs">{metric.label}</span>
        <span className="tnum font-mono text-xs">
          {hovered && hoverValue !== undefined ? (
            <>
              {hoverValue === null ? (
                // The pointer is in a gap. Say so — snapping the readout to the
                // nearest real value would attribute a measurement to a moment
                // the api has no reading for.
                <span className="text-muted-foreground">Unavailable</span>
              ) : (
                metric.fmt(hoverValue)
              )}
              <span className="text-muted-foreground"> · {clock(hovered.ts)}</span>
            </>
          ) : (
            <>
              {metric.fmt(extent.min)}
              <span className="text-muted-foreground"> – </span>
              {metric.fmt(extent.max)}
            </>
          )}
        </span>
      </div>
      <div
        className="relative mt-1 cursor-crosshair touch-none"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (rect.width <= 0) return
          const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
          onHover(domain.start + frac * (domain.end - domain.start))
        }}
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-8 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${metric.label} history: between ${metric.fmt(extent.min)} and ${metric.fmt(extent.max)}${
            unavailableCount > 0
              ? `; ${unavailableCount} of ${sampleCount} readings unavailable, drawn as gaps`
              : ''
          }`}
        >
          {segments.map((segment) => {
            const points = downsampleSegment(segment, MAX_DRAW_POINTS)
            const first = points[0]
            if (!first) return null
            if (points.length === 1) {
              // A lone reading between gaps still gets ink — a round-capped
              // zero-length stroke survives the non-uniform viewBox stretch.
              return (
                <path
                  key={first.t}
                  data-testid="series-point"
                  d={`M ${x(first.t).toFixed(2)} ${y(first.v).toFixed(2)} l 0.01 0`}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth="4"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )
            }
            const line = points
              .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`)
              .join(' ')
            const last = points[points.length - 1]
            const area = last
              ? `${line} L ${x(last.t).toFixed(2)} ${VIEW_H} L ${x(first.t).toFixed(2)} ${VIEW_H} Z`
              : null
            return (
              <g key={first.t}>
                {area ? <path d={area} fill="var(--primary)" fillOpacity="0.08" /> : null}
                <path
                  data-testid="series-segment"
                  d={line}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )
          })}
        </svg>
        {hoverPct !== null ? (
          <div
            className="bg-foreground/25 pointer-events-none absolute inset-y-0 w-px"
            style={{ left: `${hoverPct}%` }}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  )
}
