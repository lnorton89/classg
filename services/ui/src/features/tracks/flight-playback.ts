/**
 * Replaying a recorded flight: where the aircraft was at an arbitrary instant.
 *
 * Dedrone's alert replay and AeroScope's Track Playback both exist because a
 * static polyline answers "where did it go" and not "in what order, and how
 * fast". Scrubbing is the only way to read a route that crosses itself.
 *
 * The interesting case is the one nobody designs for: a reception gap. Between
 * the last fix before a 7-minute silence and the first one after it, nothing
 * knows where the aircraft was, and sliding a marker smoothly along the
 * straight line joining them would be the most authoritative-looking lie on the
 * page. So the marker HOLDS at the last heard fix for the whole gap and the
 * frame says `heard: false`, which is what the map draws as a dashed segment
 * and the scrubber shows as "not heard".
 */
import type { Position } from '@/lib/api/types'

import { pointMs } from './flight-speed'
import { TRAIL_GAP_MS } from '@/features/map/geo'

export interface PlaybackSpan {
  startMs: number
  endMs: number
}

/**
 * The window the scrubber covers, or null when the path carries no usable
 * timestamps. A zero-length span (one dated point) is still a span: the
 * scrubber renders disabled rather than absent, which says "there is nothing
 * to replay" instead of silently dropping a control.
 */
export function playbackSpan(path: Position[]): PlaybackSpan | null {
  let startMs = Infinity
  let endMs = -Infinity
  for (const position of path) {
    const ms = pointMs(position)
    if (ms === null) continue
    startMs = Math.min(startMs, ms)
    endMs = Math.max(endMs, ms)
  }
  return startMs === Infinity ? null : { startMs, endMs }
}

export interface PlaybackFrame {
  lat: number
  lon: number
  /** Interpolated where both ends reported one, else whichever end did. */
  heightAglM: number | null
  speedMps: number | null
  trackDeg: number | null
  /** The instant this frame represents, which is the scrubbed time. */
  atMs: number
  /** Index of the path point at or before `atMs`. */
  index: number
  /**
   * False while the aircraft was not being heard. The position is then the
   * last known fix held in place, not an estimate of where it actually was.
   */
  heard: boolean
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Shortest-way-round interpolation, so 350° → 10° crosses north rather than unwinding. */
function lerpDegrees(a: number, b: number, t: number): number {
  const delta = ((b - a + 540) % 360) - 180
  return (a + delta * t + 360) % 360
}

function optionalLerp(
  a: number | null | undefined,
  b: number | null | undefined,
  t: number,
): number | null {
  const from = typeof a === 'number' && Number.isFinite(a) ? a : null
  const to = typeof b === 'number' && Number.isFinite(b) ? b : null
  if (from !== null && to !== null) return lerp(from, to, t)
  // One end only: hold it rather than dropping the reading. Holding a reported
  // height across a point that never carried one is what the aircraft's own
  // broadcast cadence implies; averaging it with nothing is not.
  return from ?? to
}

interface Dated {
  position: Position
  ms: number
}

/**
 * The dated points of a path, in order, remembered per path array.
 *
 * `frameAt` is called twice per render and the scrubber re-renders ten times a
 * second, so rebuilding and re-sorting a few thousand points there is real
 * work repeated for an identical answer. The key is the array identity, which
 * the page already holds stable through a `useMemo`; a WeakMap means a path
 * that falls out of scope takes its index with it.
 */
const datedCache = new WeakMap<Position[], Dated[]>()

function datedPoints(path: Position[]): Dated[] {
  const cached = datedCache.get(path)
  if (cached) return cached
  // Only dated points can be placed on a time axis. An undated fix is still
  // drawn on the map by the path layers; it just cannot be scrubbed to.
  const dated: Dated[] = []
  for (const position of path) {
    const ms = pointMs(position)
    if (ms !== null) dated.push({ position, ms })
  }
  dated.sort((a, b) => a.ms - b.ms)
  datedCache.set(path, dated)
  return dated
}

/**
 * The aircraft's state at `atMs`.
 *
 * Clamped to the ends of the path: scrubbing before the first fix shows the
 * first fix, not an empty map. Returns null only when the path has no dated
 * points at all, which is the case the scrubber refuses to render for.
 */
export function frameAt(path: Position[], atMs: number): PlaybackFrame | null {
  const dated = datedPoints(path)
  if (dated.length === 0) return null

  const first = dated[0]
  const last = dated[dated.length - 1]
  if (!first || !last) return null
  if (atMs <= first.ms) return frameOf(first.position, first.ms, 0, true)
  if (atMs >= last.ms) return frameOf(last.position, last.ms, dated.length - 1, true)

  // Binary search rather than a scan: the path is rebuilt from detections and
  // routinely runs to a few thousand points, and this is called on every
  // animation frame during playback.
  let lo = 0
  let hi = dated.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    const entry = dated[mid]
    if (!entry) break
    if (entry.ms <= atMs) lo = mid
    else hi = mid
  }

  const from = dated[lo]
  const to = dated[hi]
  if (!from || !to) return null

  if (to.ms - from.ms > TRAIL_GAP_MS) {
    // Held, not interpolated. See the note at the top of this file.
    return frameOf(from.position, atMs, lo, false)
  }

  const span = to.ms - from.ms
  const t = span > 0 ? (atMs - from.ms) / span : 0
  return {
    lat: lerp(from.position.lat, to.position.lat, t),
    lon: lerp(from.position.lon, to.position.lon, t),
    heightAglM: optionalLerp(from.position.height_agl_m, to.position.height_agl_m, t),
    speedMps: optionalLerp(from.position.speed_mps, to.position.speed_mps, t),
    trackDeg:
      typeof from.position.track_deg === 'number' && typeof to.position.track_deg === 'number'
        ? lerpDegrees(from.position.track_deg, to.position.track_deg, t)
        : (from.position.track_deg ?? to.position.track_deg ?? null),
    atMs,
    index: lo,
    heard: true,
  }
}

function frameOf(
  position: Position,
  atMs: number,
  index: number,
  heard: boolean,
): PlaybackFrame {
  return {
    lat: position.lat,
    lon: position.lon,
    heightAglM: position.height_agl_m ?? null,
    speedMps: position.speed_mps ?? null,
    trackDeg: position.track_deg ?? null,
    atMs,
    index,
    heard,
  }
}

/** Playback rates the scrubber offers. 10x turns a ten-minute flight into a minute. */
export const PLAYBACK_RATES = [1, 4, 10] as const
export type PlaybackRate = (typeof PLAYBACK_RATES)[number]
