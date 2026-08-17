/**
 * The band, drawn.
 *
 * Hand-rolled SVG following the RssiChart and HostHistory precedent: a charting
 * library would be the largest thing in a bundle served by a Pi over its own
 * access point.
 *
 * Two rules shape everything here.
 *
 * **A null cell is a gap.** The line breaks. Those cells are the receiver's own
 * DC guard at each step centre, or spectrum nothing tuned to — drawing a level
 * across either shows a quiet frequency that was never measured, and a control
 * link sitting in a notch would render as a smooth floor. The split lives in
 * trace-series.ts where plain unit tests pin it.
 *
 * **Nothing here classifies.** A peak above the threshold means something is
 * transmitting. It does not mean a drone, the chart never says it does, and the
 * detector that could tell an ELRS burst train from a smart meter is Milestone 3
 * and needs a test transmitter to validate against.
 */
import { useState } from 'react'

import { cn } from '@/lib/cn'
import type { SpectrumSweepDetail, SpectrumTrace } from '@/lib/api/types'

import {
  blindPercent,
  cellHz,
  fractionAtHz,
  formatDbfs,
  formatMHz,
  hzAtFraction,
  nearestCell,
  plotRange,
  traceExtent,
  traceSegments,
} from './trace-series'

const VIEW_W = 1000
const VIEW_H = 260
const PAD_TOP = 10
const PAD_BOTTOM = 10

export function SpectrumChart({ sweep }: { sweep: SpectrumSweepDetail }) {
  const [hoverHz, setHoverHz] = useState<number | null>(null)
  const trace = sweep.trace

  if (!trace || trace.dbfs.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        This sweep has no measurement to draw.
      </p>
    )
  }

  const segments = traceSegments(trace)
  const extent = traceExtent(segments)
  const range = plotRange(extent, sweep.noise_floor_dbfs, sweep.threshold_dbfs)

  const x = (hz: number) => fractionAtHz(trace, hz) * VIEW_W
  const y = (db: number) =>
    PAD_TOP + (1 - (db - range.min) / (range.max - range.min)) * (VIEW_H - PAD_TOP - PAD_BOTTOM)

  const hoverIndex = hoverHz === null ? null : nearestCell(trace, hoverHz)
  const hoverDb = hoverIndex === null ? undefined : trace.dbfs[hoverIndex]
  const blind = blindPercent(trace)

  return (
    <div>
      <ChartReadout
        trace={trace}
        hoverIndex={hoverIndex}
        hoverDb={hoverDb}
        extent={extent}
        sweep={sweep}
      />

      <div
        className="relative mt-2 cursor-crosshair touch-none"
        onPointerLeave={() => setHoverHz(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (rect.width <= 0) return
          const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
          setHoverHz(hzAtFraction(trace, frac))
        }}
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="bg-muted/20 border-border/60 h-56 w-full rounded-md border sm:h-64"
          preserveAspectRatio="none"
          role="img"
          aria-label={chartLabel(sweep, trace, extent)}
        >
          {/* The noise floor and the +10 dB threshold, as reference lines. The
              threshold is what "above the floor" is measured against; it is not
              a detection line, because nothing here detects. */}
          <ReferenceLine
            db={sweep.noise_floor_dbfs}
            y={y}
            className="stroke-muted-foreground/50"
            dash="4 4"
          />
          <ReferenceLine
            db={sweep.threshold_dbfs}
            y={y}
            className="stroke-warn/60"
            dash="7 5"
          />

          {segments.map((segment) => {
            const first = segment[0]
            if (!first) return null
            if (segment.length === 1) {
              // A lone reading between two notches still gets ink. A
              // round-capped zero-length stroke survives the stretched viewBox.
              return (
                <path
                  key={first.hz}
                  data-testid="trace-point"
                  d={`M ${x(first.hz).toFixed(2)} ${y(first.db).toFixed(2)} l 0.01 0`}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )
            }
            return (
              <path
                key={first.hz}
                data-testid="trace-segment"
                d={segment
                  .map(
                    (p, i) =>
                      `${i === 0 ? 'M' : 'L'} ${x(p.hz).toFixed(2)} ${y(p.db).toFixed(2)}`,
                  )
                  .join(' ')}
                fill="none"
                stroke="var(--primary)"
                strokeWidth="1.5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )
          })}

          {hoverHz !== null ? (
            <line
              x1={x(hoverHz)}
              x2={x(hoverHz)}
              y1={0}
              y2={VIEW_H}
              className="stroke-foreground/30"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
      </div>

      <div className="text-muted-foreground tnum mt-1 flex items-baseline justify-between gap-4 text-2xs">
        <span>{formatMHz(trace.start_hz)}</span>
        <span>{formatMHz((trace.start_hz + trace.stop_hz) / 2)}</span>
        <span>{formatMHz(trace.stop_hz)}</span>
      </div>

      <Legend blind={blind} trace={trace} sweep={sweep} />
    </div>
  )
}

function ReferenceLine({
  db,
  y,
  className,
  dash,
}: {
  db: number | null | undefined
  y: (db: number) => number
  className: string
  dash: string
}) {
  if (typeof db !== 'number' || !Number.isFinite(db)) return null
  return (
    <line
      x1={0}
      x2={VIEW_W}
      y1={y(db)}
      y2={y(db)}
      className={className}
      strokeWidth="1"
      strokeDasharray={dash}
      vectorEffect="non-scaling-stroke"
    />
  )
}

function ChartReadout({
  trace,
  hoverIndex,
  hoverDb,
  extent,
  sweep,
}: {
  trace: SpectrumTrace
  hoverIndex: number | null
  hoverDb: number | null | undefined
  extent: { min: number; max: number } | null
  sweep: SpectrumSweepDetail
}) {
  if (hoverIndex !== null) {
    return (
      <p data-testid="chart-readout" className="tnum font-mono text-xs">
        {formatMHz(cellHz(trace, hoverIndex))}
        <span className="text-muted-foreground"> · </span>
        {hoverDb === null || hoverDb === undefined ? (
          // The pointer is in a notch. Saying "unmeasured" rather than
          // snapping to the nearest reading is the whole point: a reading
          // labelled with a frequency it was not taken at is a fabricated
          // detection.
          <span className="text-muted-foreground font-sans">
            Unmeasured — the receiver is blind here
          </span>
        ) : (
          formatDbfs(hoverDb)
        )}
      </p>
    )
  }

  return (
    <p data-testid="chart-readout" className="tnum font-mono text-xs">
      {extent ? (
        <>
          {formatDbfs(extent.min)}
          <span className="text-muted-foreground"> – </span>
          {formatDbfs(extent.max)}
        </>
      ) : (
        <span className="text-muted-foreground font-sans">Nothing measured</span>
      )}
      {typeof sweep.peak_hz === 'number' && typeof sweep.peak_dbfs === 'number' ? (
        <span className="text-muted-foreground font-sans">
          {' '}
          · strongest {formatDbfs(sweep.peak_dbfs)} at {formatMHz(sweep.peak_hz)}
        </span>
      ) : null}
    </p>
  )
}

function Legend({
  blind,
  trace,
  sweep,
}: {
  blind: number
  trace: SpectrumTrace
  sweep: SpectrumSweepDetail
}) {
  const above =
    typeof sweep.threshold_dbfs === 'number' &&
    typeof sweep.peak_dbfs === 'number' &&
    sweep.peak_dbfs > sweep.threshold_dbfs

  return (
    <div className="text-muted-foreground mt-2 space-y-1.5 text-2xs leading-relaxed">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <LegendSwatch className="bg-muted-foreground/50" label="noise floor (median)" />
        <LegendSwatch className="bg-warn/60" label="+10 dB threshold" />
      </p>

      {blind > 0 ? (
        <p>
          <span className="text-foreground">{blind.toFixed(1)}% of the band is a gap</span> —{' '}
          {trace.blind} of {trace.dbfs.length} cells. The receiver is zero-IF, so its own
          oscillator lands at every step centre and those bins are masked; the 20% step
          overlap covers the rolled-off step edges, not the centres. The line breaks
          rather than joining across, because a level drawn there would be a frequency
          nobody measured.
        </p>
      ) : null}

      {sweep.short_reads ? (
        <p className="text-warn">
          {sweep.short_reads} step{sweep.short_reads === 1 ? '' : 's'} read too short to
          transform, so this covers less of the band than the axis suggests.
        </p>
      ) : null}

      <p>
        {above
          ? 'Something in this band is above the floor. That is all this says — energy, ' +
            'not identity.'
          : 'Nothing here cleared the threshold at the moment of the sweep.'}{' '}
        Deciding that a burst train is a control link rather than a smart meter needs
        cadence analysis this build does not ship, so no line on this chart is a drone.
      </p>
    </div>
  )
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-block h-px w-4', className)} aria-hidden />
      {label}
    </span>
  )
}

function chartLabel(
  sweep: SpectrumSweepDetail,
  trace: SpectrumTrace,
  extent: { min: number; max: number } | null,
): string {
  const span = `${formatMHz(trace.start_hz)} to ${formatMHz(trace.stop_hz)}`
  const levels = extent
    ? `between ${formatDbfs(extent.min)} and ${formatDbfs(extent.max)}`
    : 'with nothing measured'
  const gaps =
    trace.blind > 0
      ? `; ${trace.blind} of ${trace.dbfs.length} cells unmeasured and drawn as gaps`
      : ''
  return `Power spectrum of ${sweep.band}, ${span}, ${levels}${gaps}. Energy only; no signal is identified.`
}
