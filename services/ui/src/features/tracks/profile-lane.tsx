/**
 * One lane of the flight profiles: a value against the flight's own clock.
 *
 * This is `RssiChart` generalised. That component was a single hand-rolled SVG
 * of signal strength over time, and height AGL and speed want exactly the same
 * plot over exactly the same seconds — so rather than three charts with three
 * independent x-axes stacked under the map, there is one lane component and
 * one shared `domain` passed to every instance. Lanes that share an axis can be
 * read across: the dip in height and the spike in RSSI line up, or they do not,
 * and that is the whole reason to stack them.
 *
 * Still hand-rolled SVG rather than a charting library, for the original
 * reason: it is a line and two gridlines, and a chart library would be the
 * single largest dependency in a bundle the Pi serves over its own Wi-Fi AP.
 *
 * Colour never encodes magnitude here. Each lane is one series in one hue (the
 * RSSI lane gets one per receiver, which is identity, not magnitude); the map's
 * speed ramp is the only sequential scale on the page, and giving the profiles
 * a second one would make the same colour mean two things on one screen.
 */
import { useId, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { AccessibleChartTable } from '@/components/ui/accessible-chart-table'
import type { ChartTableColumn } from '@/components/ui/accessible-chart-table'
import { useFormat } from '@/app/use-format'
import { cn } from '@/lib/cn'

export interface ProfilePoint {
  ms: number
  value: number
}

export interface ProfileSeries {
  id: string
  label: string
  points: ProfilePoint[]
  /** A CSS colour or `var(--token)`. Defaults to the track hue. */
  color?: string
}

export interface ProfileDomain {
  startMs: number
  endMs: number
}

interface LaneRow {
  entry: ProfileSeries
  point: ProfilePoint
}

const WIDTH = 600
const PADDING = { top: 8, right: 8, bottom: 6, left: 42 }

/**
 * A series is drawn as separate polylines wherever its samples are further
 * apart than this, so a reception gap is a break in the trace rather than a
 * confident straight line across it — the same rule the map's dashed trail
 * follows, applied to the profiles.
 */
const PROFILE_GAP_MS = 30_000

function segmentsOf(points: ProfilePoint[]): ProfilePoint[][] {
  const runs: ProfilePoint[][] = []
  let run: ProfilePoint[] = []
  let previous: ProfilePoint | null = null
  for (const point of points) {
    if (previous && point.ms - previous.ms > PROFILE_GAP_MS) {
      runs.push(run)
      run = []
    }
    run.push(point)
    previous = point
  }
  runs.push(run)
  return runs.filter((entry) => entry.length > 0)
}

export function ProfileLane({
  title,
  unit,
  series,
  domain,
  format: formatValue,
  height = 92,
  cursorMs = null,
  onHoverMs,
  emptyNote,
  className,
}: {
  title: string
  /** Shown once beside the title, so no gridline label has to repeat it. */
  unit: string
  series: ProfileSeries[]
  domain: ProfileDomain
  format: (value: number) => string
  height?: number
  /** Where the scrubber is. Drawn on every lane so the lanes stay in step. */
  cursorMs?: number | null
  /** Hovering a lane moves the shared cursor, which also moves the map marker. */
  onHoverMs?: (ms: number | null) => void
  emptyNote: string
  className?: string
}) {
  const gradientId = useId()
  const format = useFormat()
  const svgRef = useRef<SVGSVGElement>(null)

  const plotted = series.filter((entry) => entry.points.length > 0)
  const total = plotted.reduce((sum, entry) => sum + entry.points.length, 0)

  if (total === 0) {
    return (
      <figure className={cn('m-0', className)}>
        <figcaption className="text-muted-foreground mb-1 flex items-baseline gap-2 text-2xs">
          <span className="text-foreground font-medium">{title}</span>
        </figcaption>
        <p className="text-muted-foreground text-2xs">{emptyNote}</p>
      </figure>
    )
  }

  const plotWidth = WIDTH - PADDING.left - PADDING.right
  const plotHeight = height - PADDING.top - PADDING.bottom
  const span = Math.max(1, domain.endMs - domain.startMs)

  let minValue = Infinity
  let maxValue = -Infinity
  for (const entry of plotted) {
    for (const point of entry.points) {
      minValue = Math.min(minValue, point.value)
      maxValue = Math.max(maxValue, point.value)
    }
  }
  // A flat series would otherwise divide by zero and collapse to the top edge.
  // Padding it symmetrically draws the line through the middle, which is what
  // "it did not change" looks like.
  if (minValue === maxValue) {
    minValue -= 1
    maxValue += 1
  }
  const range = maxValue - minValue

  const x = (ms: number) => PADDING.left + ((ms - domain.startMs) / span) * plotWidth
  const y = (value: number) => PADDING.top + (1 - (value - minValue) / range) * plotHeight

  const gridValues = [maxValue, (maxValue + minValue) / 2, minValue]

  const rows: LaneRow[] = plotted.flatMap((entry) =>
    entry.points.map((point) => ({ entry, point })),
  )
  const columns: ChartTableColumn<LaneRow>[] = [
    {
      key: 'time',
      label: `Time (${format.zoneLabel})`,
      render: (row) => format.clock(new Date(row.point.ms).toISOString()),
    },
  ]
  if (plotted.length > 1) {
    columns.push({ key: 'series', label: 'Series', render: (row) => row.entry.label })
  }
  columns.push({ key: 'value', label: title, render: (row) => formatValue(row.point.value) })

  function msAt(event: ReactPointerEvent<SVGSVGElement>): number | null {
    const svg = svgRef.current
    if (!svg) return null
    const box = svg.getBoundingClientRect()
    if (box.width === 0) return null
    // The SVG scales to its container, so the pointer's page offset has to be
    // mapped back through the viewBox rather than used directly.
    const viewX = ((event.clientX - box.left) / box.width) * WIDTH
    const t = (viewX - PADDING.left) / plotWidth
    if (t < 0 || t > 1) return null
    return domain.startMs + t * span
  }

  return (
    <figure className={cn('m-0', className)}>
      <figcaption className="text-muted-foreground mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-2xs">
        <span className="text-foreground font-medium">{title}</span>
        <span>{unit}</span>
        {/* A legend whenever there is more than one series, so identity is
            never carried by colour alone. One series needs none: the title
            names it. */}
        {plotted.length > 1 ? (
          <span className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            {plotted.map((entry) => (
              <span key={entry.id} className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="block h-0.5 w-3 rounded"
                  style={{ background: entry.color ?? 'var(--track)' }}
                />
                <span className="font-mono">{entry.label}</span>
              </span>
            ))}
          </span>
        ) : null}
      </figcaption>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="h-auto w-full touch-none"
        role="img"
        aria-label={`${title} over the flight, ${total} samples between ${formatValue(minValue)} and ${formatValue(maxValue)}`}
        preserveAspectRatio="none"
        onPointerMove={(event) => onHoverMs?.(msAt(event))}
        onPointerLeave={() => onHoverMs?.(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--track)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--track)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridValues.map((value, index) => (
          <g key={index}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={y(value)}
              y2={y(value)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={PADDING.left - 5}
              y={y(value) + 3}
              textAnchor="end"
              className="fill-[var(--muted-foreground)] text-[9px]"
            >
              {formatValue(value)}
            </text>
          </g>
        ))}

        {plotted.map((entry) => {
          const colour = entry.color ?? 'var(--track)'
          const runs = segmentsOf(entry.points)
          return (
            <g key={entry.id}>
              {/* The fill under the trace is only drawn for a lone series.
                  Two overlapping washes read as a third value. */}
              {plotted.length === 1
                ? runs.map((run, index) => {
                    const first = run[0]
                    const last = run[run.length - 1]
                    if (!first || !last || run.length < 2) return null
                    const line = run
                      .map(
                        (p, i) =>
                          `${i === 0 ? 'M' : 'L'} ${x(p.ms).toFixed(2)} ${y(p.value).toFixed(2)}`,
                      )
                      .join(' ')
                    return (
                      <path
                        key={`area-${index}`}
                        d={`${line} L ${x(last.ms).toFixed(2)} ${PADDING.top + plotHeight} L ${x(first.ms).toFixed(2)} ${PADDING.top + plotHeight} Z`}
                        fill={`url(#${gradientId})`}
                      />
                    )
                  })
                : null}
              {runs.map((run, index) =>
                run.length < 2 ? (
                  <circle
                    key={`dot-${index}`}
                    cx={x(run[0]?.ms ?? domain.startMs)}
                    cy={y(run[0]?.value ?? minValue)}
                    r={1.6}
                    fill={colour}
                  />
                ) : (
                  <path
                    key={`line-${index}`}
                    d={run
                      .map(
                        (p, i) =>
                          `${i === 0 ? 'M' : 'L'} ${x(p.ms).toFixed(2)} ${y(p.value).toFixed(2)}`,
                      )
                      .join(' ')}
                    fill="none"
                    stroke={colour}
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ),
              )}
            </g>
          )
        })}

        {cursorMs !== null && cursorMs >= domain.startMs && cursorMs <= domain.endMs ? (
          <line
            x1={x(cursorMs)}
            x2={x(cursorMs)}
            y1={PADDING.top}
            y2={PADDING.top + plotHeight}
            stroke="var(--foreground)"
            strokeWidth="1"
            strokeOpacity="0.55"
            strokeDasharray="3 2"
          />
        ) : null}
      </svg>

      <AccessibleChartTable
        className="mt-0.5"
        summary={`Show ${title.toLowerCase()} as a table (${total} samples)`}
        lazy
        rows={rows}
        rowKey={(row) => `${row.entry.id}-${row.point.ms}-${row.point.value}`}
        columns={columns}
      />
    </figure>
  )
}
