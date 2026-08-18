/**
 * Turning telemetry samples into drawable line segments.
 *
 * The one rule this file exists to enforce: **a null reading is a gap, never a
 * value**. A sample whose figure the api could not read must break the line —
 * drawing a point at zero, or a line interpolated straight across the hole,
 * puts fabricated data in the same ink as measurements. 0 °C and 0 bytes free
 * are both plausible readings, which is exactly what makes them lies here.
 *
 * Two distinct absences produce gaps:
 *   - a row whose field is null — the sampler ran, the reading failed;
 *   - rows that are missing entirely — the sampler itself was down, visible
 *     as a hole in the timestamps.
 * Both mean "no data", and a line drawn across either claims knowledge the
 * system does not have.
 *
 * Pure and React-free so the rule is pinned by plain unit tests.
 */
import type { TelemetrySample } from '@/lib/api/types'

export interface TelemetryPoint {
  /** Epoch milliseconds. */
  t: number
  v: number
}

const NOMINAL_CADENCE_MS = 60_000

/**
 * Median spacing between consecutive rows, used to tell "the next minute" from
 * "the sampler was down for an hour". Falls back to the nominal one-a-minute
 * cadence when there are too few rows to measure.
 */
export function sampleCadenceMs(samples: readonly TelemetrySample[]): number {
  const deltas: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const curr = samples[i]
    if (!prev || !curr) continue
    const dt = Date.parse(curr.ts) - Date.parse(prev.ts)
    if (dt > 0) deltas.push(dt)
  }
  if (deltas.length === 0) return NOMINAL_CADENCE_MS
  deltas.sort((a, b) => a - b)
  return deltas[Math.floor(deltas.length / 2)] ?? NOMINAL_CADENCE_MS
}

/**
 * Split one figure's history into runs of consecutive real readings.
 *
 * A segment ends at a null reading or at a timestamp jump larger than
 * 2.5x the measured cadence (a vanished-rows outage). Segments with a single
 * point are kept — a lone reading between two gaps is still a reading, and
 * dropping it would hide the only evidence in that stretch.
 */
export function splitSegments(
  samples: readonly TelemetrySample[],
  pick: (sample: TelemetrySample) => number | null,
): TelemetryPoint[][] {
  const gapThreshold = sampleCadenceMs(samples) * 2.5
  const segments: TelemetryPoint[][] = []
  let current: TelemetryPoint[] = []

  for (const sample of samples) {
    const value = pick(sample)
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    const t = Date.parse(sample.ts)
    const last = current[current.length - 1]
    if (last && t - last.t > gapThreshold) {
      segments.push(current)
      current = []
    }
    current.push({ t, v: value })
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/** Min and max across every segment, or null when the window has no readings. */
export function seriesExtent(segments: readonly TelemetryPoint[][]): {
  min: number
  max: number
} | null {
  let min = Infinity
  let max = -Infinity
  for (const segment of segments) {
    for (const point of segment) {
      if (point.v < min) min = point.v
      if (point.v > max) max = point.v
    }
  }
  return min <= max ? { min, max } : null
}

/**
 * Thin a segment for drawing while keeping its shape honest: each bucket
 * contributes its min and max point in time order, so spikes survive. Never
 * called across segment boundaries — decimation must not bridge a gap.
 */
export function downsampleSegment(
  points: readonly TelemetryPoint[],
  maxPoints: number,
): TelemetryPoint[] {
  if (points.length <= maxPoints || maxPoints < 4) return [...points]
  const bucketCount = Math.floor(maxPoints / 2)
  const bucketSize = points.length / bucketCount
  const out: TelemetryPoint[] = []
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * bucketSize)
    const end = Math.min(points.length, Math.max(start + 1, Math.floor((b + 1) * bucketSize)))
    let lo: TelemetryPoint | undefined
    let hi: TelemetryPoint | undefined
    for (let i = start; i < end; i++) {
      const p = points[i]
      if (!p) continue
      if (!lo || p.v < lo.v) lo = p
      if (!hi || p.v > hi.v) hi = p
    }
    if (!lo || !hi) continue
    if (lo === hi) out.push(lo)
    else out.push(...(lo.t <= hi.t ? [lo, hi] : [hi, lo]))
  }
  return out
}

/**
 * Nearest sample to a timestamp, for the hover readout. Returns the index so
 * the caller can read whichever figures it wants off the row — including a
 * null, which the readout must say out loud rather than skip to a neighbour
 * that would misattribute a real reading to the gap the pointer is in.
 */
export function nearestSampleIndex(
  samples: readonly TelemetrySample[],
  t: number,
): number | null {
  if (samples.length === 0) return null
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    const midSample = samples[mid]
    if (!midSample) break
    if (Date.parse(midSample.ts) <= t) lo = mid
    else hi = mid
  }
  const loSample = samples[lo]
  const hiSample = samples[hi]
  if (!loSample) return hi
  if (!hiSample) return lo
  return Math.abs(Date.parse(loSample.ts) - t) <= Math.abs(Date.parse(hiSample.ts) - t)
    ? lo
    : hi
}
