/**
 * Turning a spectrum trace into drawable line segments.
 *
 * The rule, identical to telemetry-series.ts and for the same reason: **a null
 * cell is a gap, never a value**. Here the stakes are a little sharper, because
 * the two things that produce a null are both places an operator would most
 * like to see a signal:
 *
 *   - the DC guard at every step centre. The RTL-SDR is zero-IF, so its own
 *     local oscillator lands at the tuned frequency; the sensor masks three
 *     bins either side, leaving a ~16 kHz blind notch every 1.92 MHz that the
 *     step overlap does not close.
 *   - a gap between steps, which is spectrum nothing ever tuned to.
 *
 * Joining a line across either draws a quiet frequency that was never measured.
 * A drone control link sitting in a notch would show up as a smooth floor.
 *
 * Pure and React-free so the rule is pinned by plain unit tests.
 */
import type { SpectrumTrace } from '@/lib/api/types'

export interface TracePoint {
  /** Frequency in Hz, at the centre of the cell. */
  hz: number
  /** Power in dBFS. */
  db: number
}

/** Centre frequency of cell `index`. */
export function cellHz(trace: SpectrumTrace, index: number): number {
  return trace.start_hz + (index + 0.5) * trace.bin_width_hz
}

/**
 * Split a trace into runs of consecutive measured cells.
 *
 * Single-point segments are kept: one cell between two notches is still a
 * reading, and dropping it would hide the only evidence at that frequency.
 * They are drawn as dots rather than lines by the chart.
 */
export function traceSegments(trace: SpectrumTrace | undefined): TracePoint[][] {
  if (!trace || trace.dbfs.length === 0) return []

  const segments: TracePoint[][] = []
  let current: TracePoint[] = []

  trace.dbfs.forEach((db, index) => {
    if (db === null || !Number.isFinite(db)) {
      if (current.length > 0) segments.push(current)
      current = []
      return
    }
    current.push({ hz: cellHz(trace, index), db })
  })
  if (current.length > 0) segments.push(current)
  return segments
}

/** Min and max dBFS across every segment, or null when nothing was measured. */
export function traceExtent(
  segments: readonly TracePoint[][],
): { min: number; max: number } | null {
  let min = Infinity
  let max = -Infinity
  for (const segment of segments) {
    for (const point of segment) {
      if (point.db < min) min = point.db
      if (point.db > max) max = point.db
    }
  }
  return min <= max ? { min, max } : null
}

/**
 * The dBFS window to draw, padded and widened so the floor and threshold lines
 * are always on the plot.
 *
 * Including the threshold matters: a band with nothing above it should show an
 * empty headroom rather than a trace pushed against the top edge, because
 * "nothing here cleared the threshold" is the answer most sweeps give and the
 * chart should make that visible at a glance.
 */
export function plotRange(
  extent: { min: number; max: number } | null,
  floorDb: number | null | undefined,
  thresholdDb: number | null | undefined,
): { min: number; max: number } {
  let min = extent ? extent.min : -100
  let max = extent ? extent.max : 0

  for (const line of [floorDb, thresholdDb]) {
    if (typeof line === 'number' && Number.isFinite(line)) {
      min = Math.min(min, line)
      max = Math.max(max, line)
    }
  }
  // A flat band would otherwise divide by zero and draw a line of infinite
  // thickness through the middle.
  if (max - min < 6) {
    const mid = (max + min) / 2
    min = mid - 3
    max = mid + 3
  }
  const pad = (max - min) * 0.08
  return { min: min - pad, max: max + pad }
}

/**
 * Cell index nearest a frequency, or null when the trace does not cover it.
 *
 * Returns the index even when that cell is null, so a hover over a notch can
 * say "unmeasured here" rather than silently snapping to the nearest reading
 * several kHz away and labelling it with the cursor's frequency.
 */
export function nearestCell(trace: SpectrumTrace | undefined, hz: number): number | null {
  if (!trace || trace.dbfs.length === 0) return null
  const index = Math.round((hz - trace.start_hz) / trace.bin_width_hz - 0.5)
  if (index < 0 || index >= trace.dbfs.length) return null
  return index
}

/** Hz for a 0..1 position across the trace. */
export function hzAtFraction(trace: SpectrumTrace, fraction: number): number {
  return trace.start_hz + fraction * (trace.stop_hz - trace.start_hz)
}

/** 0..1 position of a frequency across the trace, clamped. */
export function fractionAtHz(trace: SpectrumTrace, hz: number): number {
  const span = trace.stop_hz - trace.start_hz
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (hz - trace.start_hz) / span))
}

/** MHz, to a sensible number of digits for a band a few tens of MHz wide. */
export function formatMHz(hz: number, digits = 3): string {
  return `${(hz / 1e6).toFixed(digits)} MHz`
}

export function formatDbfs(db: number): string {
  return `${db.toFixed(1)} dBFS`
}

/**
 * How much of the band is unmeasured, as a percentage.
 *
 * Surfaced rather than buried: a sweep whose steps mostly read short covers far
 * less of the band than its axis claims, and the number is the honest way to
 * say so.
 */
export function blindPercent(trace: SpectrumTrace | undefined): number {
  if (!trace || trace.dbfs.length === 0) return 0
  return (trace.blind / trace.dbfs.length) * 100
}
