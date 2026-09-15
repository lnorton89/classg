/**
 * Per-segment speed along a flight, and the places the aircraft stopped.
 *
 * The detail map colours the route by how fast the aircraft was going, which
 * turns a flat polyline into a reading of the flight: the transit out is one
 * shade, the slow sweep over the target another, and a hover is a dot. None of
 * that is available from the shape alone.
 *
 * Two honesty rules govern everything here, because the source is patchy:
 *
 * - `speed_mps` is optional per point (a DJI DroneID frame carries it, an
 *   ASTM F3411 Basic ID does not), so a run of nulls between two reported
 *   speeds is INTERPOLATED and anything past the last reported speed is left
 *   null. Extrapolating off the end would invent a measurement at exactly the
 *   moment the aircraft stopped reporting one.
 * - Nothing is interpolated ACROSS a reception gap. A 7-minute silence is not
 *   a leg of the flight (see TRAIL_GAP_MS in features/map/geo.ts); it is the
 *   interval we know least about, and filling it with a smooth ramp between
 *   the speeds either side would be the most confident-looking part of the
 *   whole plot.
 */
import { TRAIL_GAP_MS } from '@/features/map/geo'
import type { Position } from '@/lib/api/types'

/** Epoch ms of a point's timestamp, or null when it has none or it is unparseable. */
export function pointMs(position: Position): number | null {
  if (!position.at) return null
  const ms = Date.parse(position.at)
  return Number.isFinite(ms) ? ms : null
}

function reportedSpeed(position: Position): number | null {
  const speed = position.speed_mps
  return typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 ? speed : null
}

/**
 * Whether reception was lost between two consecutive points.
 *
 * Same threshold as the map's dashed trail, read from the same constant, so a
 * segment drawn as "not heard" and a speed refused as unknowable are always
 * the same interval.
 */
function isGap(from: Position, to: Position): boolean {
  const fromMs = pointMs(from)
  const toMs = pointMs(to)
  if (fromMs === null || toMs === null) return false
  return toMs - fromMs > TRAIL_GAP_MS
}

/**
 * One speed per path point: reported where the aircraft said so, interpolated
 * where it did not, null where nothing can be said.
 *
 * Interpolation is linear in TIME rather than in point index, because the
 * points are not evenly spaced — a frame every 300 ms during a pass and every
 * 4 s at the edge of range would otherwise weight the sparse end as heavily as
 * the dense one. Points with no timestamp fall back to index weighting, which
 * is the only thing left.
 */
export function pointSpeeds(path: Position[]): (number | null)[] {
  const reported = path.map(reportedSpeed)
  const out = [...reported]

  let previousKnown = -1
  for (let i = 0; i < path.length; i += 1) {
    if (reported[i] === null) continue
    if (previousKnown >= 0 && i - previousKnown > 1) {
      fillBetween(path, out, previousKnown, i)
    }
    previousKnown = i
  }
  return out
}

function fillBetween(
  path: Position[],
  out: (number | null)[],
  startIndex: number,
  endIndex: number,
): void {
  // A gap anywhere in the run disqualifies the whole run: the aircraft was out
  // of contact somewhere in there and could have done anything.
  for (let i = startIndex; i < endIndex; i += 1) {
    const from = path[i]
    const to = path[i + 1]
    if (from && to && isGap(from, to)) return
  }

  const startValue = out[startIndex]
  const endValue = out[endIndex]
  const startPoint = path[startIndex]
  const endPoint = path[endIndex]
  if (startValue === undefined || startValue === null) return
  if (endValue === undefined || endValue === null) return
  if (!startPoint || !endPoint) return

  const startMs = pointMs(startPoint)
  const endMs = pointMs(endPoint)
  const spanMs = startMs !== null && endMs !== null ? endMs - startMs : 0

  for (let i = startIndex + 1; i < endIndex; i += 1) {
    let t = (i - startIndex) / (endIndex - startIndex)
    const point = path[i]
    if (startMs !== null && spanMs > 0 && point) {
      const ms = pointMs(point)
      if (ms !== null) t = (ms - startMs) / spanMs
    }
    out[i] = startValue + (endValue - startValue) * t
  }
}

export interface PathSegment {
  from: Position
  to: Position
  /** Mean speed over the segment in m/s, or null when neither end is known. */
  speedMps: number | null
  /** Midpoint of the segment in epoch ms, or null when either end is undated. */
  midMs: number | null
  /** Reception was lost across this segment: the aircraft's route here is unknown. */
  gap: boolean
}

/** Consecutive pairs of path points, carrying the values the ramps colour by. */
export function pathSegments(path: Position[]): PathSegment[] {
  const speeds = pointSpeeds(path)
  const segments: PathSegment[] = []
  for (let i = 0; i + 1 < path.length; i += 1) {
    const from = path[i]
    const to = path[i + 1]
    if (!from || !to) continue
    const a = speeds[i] ?? null
    const b = speeds[i + 1] ?? null
    const fromMs = pointMs(from)
    const toMs = pointMs(to)
    segments.push({
      from,
      to,
      // The mean of the two ends, or whichever end is known. A gap has no
      // speed at all: see the rule at the top of this file.
      speedMps: isGap(from, to) ? null : a !== null && b !== null ? (a + b) / 2 : (a ?? b),
      midMs: fromMs !== null && toMs !== null ? (fromMs + toMs) / 2 : (fromMs ?? toMs),
      gap: isGap(from, to),
    })
  }
  return segments
}

export interface Extent {
  min: number
  max: number
}

/**
 * The range a ramp spans, or null when nothing was measured.
 *
 * A flight with one distinct speed returns a zero-width extent rather than
 * null: the caller needs to know a measurement exists so it can say "3.2 m/s
 * throughout" instead of "no speed reported".
 */
export function speedExtent(segments: PathSegment[]): Extent | null {
  let min = Infinity
  let max = -Infinity
  for (const segment of segments) {
    if (segment.speedMps === null) continue
    min = Math.min(min, segment.speedMps)
    max = Math.max(max, segment.speedMps)
  }
  return min === Infinity ? null : { min, max }
}

/** Time span covered by the dated points of a path, or null. */
export function timeExtent(path: Position[]): Extent | null {
  let min = Infinity
  let max = -Infinity
  for (const position of path) {
    const ms = pointMs(position)
    if (ms === null) continue
    min = Math.min(min, ms)
    max = Math.max(max, ms)
  }
  return min === Infinity ? null : { min, max }
}

/**
 * Below this the aircraft is holding station rather than flying somewhere.
 *
 * 1 m/s is walking pace. GPS-reported ground speed on a hovering multirotor is
 * not zero — it wanders with the fix — so a threshold of exactly 0 would find
 * no hovers at all on real data.
 */
export const DWELL_MAX_SPEED_MPS = 1

/**
 * And it has to hold for this long to be worth a dot. Ten seconds is past a
 * pause to turn around and into "it stopped here", which is the thing an
 * operator is looking for when they review a flight.
 */
export const DWELL_MIN_MS = 10_000

export interface Dwell {
  lat: number
  lon: number
  seconds: number
  /** Epoch ms the dwell began — the scrubber jumps here when one is clicked. */
  startMs: number
  /** Index of the first path point in the dwell, for hit-testing. */
  index: number
}

/**
 * Where the aircraft hovered, one entry per run.
 *
 * Positioned at the MEAN of the run's fixes rather than at its first point. A
 * hover's fixes scatter over several metres, and picking one of them puts the
 * dot at the edge of its own scatter for no reason.
 *
 * A run is broken by a reception gap even if the speeds either side are both
 * low: the aircraft was not heard, so nothing knows it stayed.
 */
export function dwellPoints(
  path: Position[],
  options: { maxSpeedMps?: number; minMs?: number } = {},
): Dwell[] {
  const maxSpeed = options.maxSpeedMps ?? DWELL_MAX_SPEED_MPS
  const minMs = options.minMs ?? DWELL_MIN_MS
  const speeds = pointSpeeds(path)
  const dwells: Dwell[] = []

  let runStart = -1
  const flush = (endExclusive: number) => {
    if (runStart < 0) return
    const run = path.slice(runStart, endExclusive)
    const first = run[0]
    const last = run[run.length - 1]
    if (!first || !last) {
      runStart = -1
      return
    }
    const startMs = pointMs(first)
    const endMs = pointMs(last)
    if (startMs !== null && endMs !== null && endMs - startMs >= minMs) {
      let lat = 0
      let lon = 0
      for (const point of run) {
        lat += point.lat
        lon += point.lon
      }
      dwells.push({
        lat: lat / run.length,
        lon: lon / run.length,
        seconds: Math.round((endMs - startMs) / 1000),
        startMs,
        index: runStart,
      })
    }
    runStart = -1
  }

  for (let i = 0; i < path.length; i += 1) {
    const speed = speeds[i] ?? null
    const previous = path[i - 1]
    const current = path[i]
    const broken = previous && current ? isGap(previous, current) : false
    const slow = speed !== null && speed <= maxSpeed

    if (broken) flush(i)
    if (slow) {
      if (runStart < 0) runStart = i
    } else {
      flush(i)
    }
  }
  flush(path.length)

  return dwells
}
