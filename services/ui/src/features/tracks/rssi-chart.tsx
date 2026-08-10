/**
 * RSSI over time.
 *
 * Hand-rolled SVG rather than a charting library: it is one line and two axes,
 * and a chart library would be the single largest dependency in the bundle for a
 * box that serves this over its own Wi-Fi AP.
 *
 * Signal strength is a proxy for distance and nothing more — the calibration
 * record puts a Mini 5 Pro at -35 dBm at about 10 m — so the axis is labelled in
 * dBm and never translated into a range in metres.
 */
import { useId } from 'react'

import type { Detection } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { formatClock, formatRssi } from '@/lib/format'

export interface RssiSample {
  ts: string
  rssi: number
}

export function samplesFromDetections(detections: Detection[]): RssiSample[] {
  return detections
    .filter(
      (d): d is Detection & { rf: { rssi_dbm: number } } => typeof d.rf?.rssi_dbm === 'number',
    )
    .map((d) => ({ ts: d.ts, rssi: d.rf.rssi_dbm }))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

export function RssiChart({
  samples,
  className,
  height = 120,
}: {
  samples: RssiSample[]
  className?: string
  height?: number
}) {
  const gradientId = useId()

  if (samples.length < 2) {
    return (
      <p className={cn('text-muted-foreground text-xs', className)}>
        Not enough RSSI samples to plot ({samples.length}).
      </p>
    )
  }

  const width = 600
  const padding = { top: 8, right: 8, bottom: 20, left: 34 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom

  const times = samples.map((s) => Date.parse(s.ts))
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const timeSpan = Math.max(1, maxTime - minTime)

  const values = samples.map((s) => s.rssi)
  // Clamp to plausible receiver range so one bad sample cannot flatten the plot.
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const minRssi = Math.max(-110, Math.floor((rawMin - 3) / 5) * 5)
  const maxRssi = Math.min(0, Math.ceil((rawMax + 3) / 5) * 5)
  const range = Math.max(1, maxRssi - minRssi)

  const x = (ts: number) => padding.left + ((ts - minTime) / timeSpan) * plotWidth
  const y = (rssi: number) => padding.top + (1 - (rssi - minRssi) / range) * plotHeight

  const path = samples
    .map(
      (s, i) =>
        `${i === 0 ? 'M' : 'L'} ${x(Date.parse(s.ts)).toFixed(2)} ${y(s.rssi).toFixed(2)}`,
    )
    .join(' ')

  const area =
    `${path} L ${x(maxTime).toFixed(2)} ${padding.top + plotHeight} ` +
    `L ${x(minTime).toFixed(2)} ${padding.top + plotHeight} Z`

  const gridValues = [maxRssi, Math.round((maxRssi + minRssi) / 2), minRssi]

  return (
    <figure className={cn('m-0', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`RSSI over time: ${samples.length} samples between ${formatRssi(rawMin)} and ${formatRssi(rawMax)}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--track)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--track)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(value)}
              y2={y(value)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={padding.left - 5}
              y={y(value) + 3}
              textAnchor="end"
              className="fill-[var(--muted-foreground)] text-[9px]"
            >
              {value}
            </text>
          </g>
        ))}

        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={path}
          fill="none"
          stroke="var(--track)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <text
          x={padding.left}
          y={height - 5}
          className="fill-[var(--muted-foreground)] text-[9px]"
        >
          {formatClock(samples[0]?.ts)}
        </text>
        <text
          x={width - padding.right}
          y={height - 5}
          textAnchor="end"
          className="fill-[var(--muted-foreground)] text-[9px]"
        >
          {formatClock(samples[samples.length - 1]?.ts)}
        </text>
      </svg>

      <figcaption className="text-muted-foreground mt-1 text-[11px]">
        RSSI in dBm, {samples.length} samples. Signal strength indicates relative distance only.
      </figcaption>

      {/* The accessible equivalent of the plot: same data, as a table. */}
      <details className="mt-1">
        <summary className="text-muted-foreground cursor-pointer text-[11px]">
          Show RSSI samples as a table
        </summary>
        <div className="mt-1 max-h-48 overflow-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Time
                </th>
                <th scope="col" className="py-1 font-medium">
                  RSSI
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {samples.map((sample) => (
                <tr key={`${sample.ts}-${sample.rssi}`}>
                  <td className="py-0.5 pr-3">{formatClock(sample.ts)}</td>
                  <td className="py-0.5">{formatRssi(sample.rssi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
