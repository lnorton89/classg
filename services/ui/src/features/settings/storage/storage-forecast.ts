/**
 * "How long until the disk is full?"
 *
 * The question an NVR operator asks second, right after "is it recording".
 * It is answerable here because the telemetry sampler already records free
 * bytes on a timer, so the trend is a matter of reading history rather than
 * of guessing a rate from the size of one recording.
 *
 * The honesty problem is the whole of it. A least-squares fit through a noisy
 * series will always produce a number, including when free space is flat, or
 * rising because the retention job just ran, or moving by an amount smaller
 * than the noise. Reporting "full in 3 days" from any of those is worse than
 * reporting nothing: it is a specific, confident, wrong date that somebody
 * will plan around. So this returns a verdict, and "cannot say" is one of the
 * outcomes rather than an error.
 */

export type ForecastVerdict =
  | { kind: 'filling'; bytesPerDay: number; daysRemaining: number }
  /** Free space is flat or growing. Retention is keeping up. */
  | { kind: 'stable'; bytesPerDay: number }
  /** Not enough history, or the trend is inside the noise. */
  | { kind: 'unknown'; reason: string }

export interface FreeSpacePoint {
  /** Epoch ms. */
  ts: number
  /** Free bytes, or null when the reading could not be taken. */
  free: number | null
}

/** Below this the span is too short for a slope to mean anything. */
const MIN_SPAN_MS = 60 * 60 * 1000

/** Fewer readings than this and one outlier sets the slope. */
const MIN_POINTS = 8

/**
 * A trend has to shift more than this share of the current free space per day
 * before it is called a trend. Under it, the fit is reading sampler jitter and
 * the ordinary churn of a database vacuuming itself.
 */
const NOISE_FLOOR_FRACTION = 0.001

export function forecastDiskFull(points: FreeSpacePoint[]): ForecastVerdict {
  const usable = points
    .filter((p): p is { ts: number; free: number } => p.free !== null && Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts)

  if (usable.length < MIN_POINTS) {
    return { kind: 'unknown', reason: 'not enough recorded history yet' }
  }

  const first = usable[0]
  const last = usable[usable.length - 1]
  if (!first || !last) {
    return { kind: 'unknown', reason: 'not enough recorded history yet' }
  }

  const spanMs = last.ts - first.ts
  if (spanMs < MIN_SPAN_MS) {
    return { kind: 'unknown', reason: 'the recorded window is shorter than an hour' }
  }

  // Least squares on (ms since first, bytes free). Ordinary regression rather
  // than first-to-last, which a single retention purge at either end would
  // dominate entirely.
  const n = usable.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const p of usable) {
    const x = p.ts - first.ts
    sumX += x
    sumY += p.free
    sumXY += x * p.free
    sumXX += x * x
  }
  const denom = n * sumXX - sumX * sumX
  if (denom === 0) {
    return { kind: 'unknown', reason: 'every reading landed at the same moment' }
  }
  const slopePerMs = (n * sumXY - sumX * sumY) / denom
  const bytesPerDay = slopePerMs * 86_400_000

  const freeNow = last.free
  if (freeNow <= 0) {
    return { kind: 'filling', bytesPerDay, daysRemaining: 0 }
  }

  if (Math.abs(bytesPerDay) < freeNow * NOISE_FLOOR_FRACTION) {
    return { kind: 'stable', bytesPerDay }
  }
  if (bytesPerDay >= 0) {
    return { kind: 'stable', bytesPerDay }
  }

  return { kind: 'filling', bytesPerDay, daysRemaining: freeNow / -bytesPerDay }
}

/** Free space as a fraction used, or null when either figure is unreadable. */
export function usedFraction(
  totalBytes: number | null | undefined,
  freeBytes: number | null | undefined,
): number | null {
  if (typeof totalBytes !== 'number' || typeof freeBytes !== 'number') return null
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return null
  return Math.min(1, Math.max(0, 1 - freeBytes / totalBytes))
}
