/**
 * A flight, derived from the track document the list already carries.
 *
 * The Tracks page is a list of flights rendered as if it were a list of
 * aircraft. On the live unit 15 of the first 17 closed rows are one serial, and
 * every column meant to tell them apart — identity, state, confidence — holds
 * the same value on all of them. What a person actually recognises a flight by
 * is when it started, how long it lasted, how far it went and how high; all of
 * that is already in `first_seen`, `last_seen` and `history[]` and none of it
 * was ever rendered. See docs/research/08-tracks-ux.md.
 *
 * Everything here is computed client-side from the list payload on purpose:
 * fusion may one day write a `summary` object at close (phase 2), and until it
 * does these are the same numbers the detail page derives, from the same source.
 */
import { distanceMetres } from '@/features/map/geo'
import type { Position, ReceiverPosition, Track } from '@/lib/api/types'

/**
 * Which airframe a flight belongs to.
 *
 * Serial first because it survives MAC randomisation (see track.schema.json);
 * the primary MAC is the fallback for a track identified only by OUI. A track
 * with neither keys on its own id rather than joining a shared "unknown"
 * bucket — grouping two unrelated contacts under one header would state an
 * identity nothing established, which is the failure `partitionTracks` exists
 * to prevent one level up.
 */
export function aircraftKey(track: Track): string {
  const serial = track.identity?.serial
  if (serial) return `serial:${serial}`
  const mac = track.identity?.macs?.[0]
  if (mac) return `mac:${mac}`
  return `track:${track.track_id}`
}

/** The identifier shown for an aircraft: serial, else primary MAC, else track id. */
export function aircraftLabel(track: Track): string {
  return track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id
}

/** Epoch milliseconds of `first_seen`, or null when it is unparseable. */
export function flightStartMs(track: Track): number | null {
  const ms = Date.parse(track.first_seen)
  return Number.isFinite(ms) ? ms : null
}

export function flightEndMs(track: Track): number | null {
  const ms = Date.parse(track.last_seen)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Flight duration in seconds, or null.
 *
 * A negative span is a clock that moved, not a flight that ran backwards, so it
 * returns null rather than a number nobody should sort on.
 */
export function flightDurationS(track: Track): number | null {
  const start = flightStartMs(track)
  const end = flightEndMs(track)
  if (start === null || end === null || end < start) return null
  return (end - start) / 1000
}

/**
 * The positions this flight is known to have occupied.
 *
 * `history` when there is one, otherwise the single `current` fix — a track
 * that reported once still has a position, and reporting "—" for its range
 * would be a missing value where a real measurement exists.
 */
export function flightPositions(track: Track): Position[] {
  const history = track.history ?? []
  if (history.length > 0) return history
  return track.current ? [track.current] : []
}

/**
 * Furthest the aircraft got from the receiver, in metres.
 *
 * Null when no receiver position is configured: without one there is no origin
 * to measure from, and rendering 0 m — or a distance from the first fix — would
 * be a number that looks like a measurement and is not one.
 */
export function maxRangeM(track: Track, receiver: ReceiverPosition | null): number | null {
  if (!receiver) return null
  let max: number | null = null
  for (const position of flightPositions(track)) {
    const metres = distanceMetres(receiver, position)
    if (max === null || metres > max) max = metres
  }
  return max
}

/** Highest recorded height above ground, or null when no point carried one. */
export function maxHeightAglM(track: Track): number | null {
  let max: number | null = null
  for (const position of flightPositions(track)) {
    const height = position.height_agl_m
    if (typeof height !== 'number' || !Number.isFinite(height)) continue
    if (max === null || height > max) max = height
  }
  return max
}

/**
 * Fastest the aircraft was recorded going, in m/s, or null.
 *
 * Reported speeds only. The detail map interpolates a speed for points that
 * never carried one, because a line has to be drawn somewhere; a headline
 * number has no such excuse, and a maximum taken from an interpolation is a
 * record of arithmetic rather than of a flight.
 */
export function maxSpeedMps(track: Track): number | null {
  let max: number | null = null
  for (const position of flightPositions(track)) {
    const speed = position.speed_mps
    if (typeof speed !== 'number' || !Number.isFinite(speed)) continue
    if (max === null || speed > max) max = speed
  }
  return max
}

/** Whether the aircraft broadcast a System message locating its pilot. */
export function hasOperatorFix(track: Track): boolean {
  return track.operator != null
}

/**
 * The flights of one aircraft, oldest first.
 *
 * Ordered by `first_seen` rather than by `last_seen`: the question the detail
 * page's prev/next buttons answer is "what did this airframe do before this",
 * and a flight belongs at the moment it began. Ties break on track id so the
 * order is total — two flights can share a first_seen when one track was split
 * by a reception gap and both halves start in the same second.
 */
export function orderFlights(tracks: Track[]): Track[] {
  return [...tracks].sort((a, b) => {
    const aMs = flightStartMs(a)
    const bMs = flightStartMs(b)
    if (aMs !== null && bMs !== null && aMs !== bMs) return aMs - bMs
    if (aMs === null && bMs !== null) return 1
    if (bMs === null && aMs !== null) return -1
    return a.track_id.localeCompare(b.track_id)
  })
}

export interface FlightNeighbours {
  /** 1-based position in the aircraft's flights, or null when it is not among them. */
  number: number | null
  total: number
  /** The flight immediately before this one in time, or null at the start. */
  previous: Track | null
  next: Track | null
}

/**
 * Where a flight sits among its aircraft's flights, and what is either side.
 *
 * This is how the two halves of a flight that a reception gap split into two
 * tracks are reached from each other — from one of them, the other is simply
 * the next flight. There is nowhere else in the app that connection exists.
 *
 * A track that is not in the list returns `number: null` with both neighbours
 * null rather than guessing at a position. That happens legitimately: the
 * aircraft's other flights are fetched by serial, and a track with no serial
 * has no such list to be a member of.
 */
export function flightNeighbours(ordered: Track[], trackId: string): FlightNeighbours {
  const index = ordered.findIndex((track) => track.track_id === trackId)
  if (index < 0) return { number: null, total: ordered.length, previous: null, next: null }
  return {
    number: index + 1,
    total: ordered.length,
    previous: ordered[index - 1] ?? null,
    next: ordered[index + 1] ?? null,
  }
}

/** First and last `first_seen` across a set of flights, for the "Sep 4 – Sep 15" line. */
export function flightRangeMs(tracks: Track[]): { startMs: number; endMs: number } | null {
  let startMs = Infinity
  let endMs = -Infinity
  for (const track of tracks) {
    const ms = flightStartMs(track)
    if (ms === null) continue
    startMs = Math.min(startMs, ms)
    endMs = Math.max(endMs, ms)
  }
  return startMs === Infinity ? null : { startMs, endMs }
}

export const FLIGHT_SORT_VALUES = [
  'start-asc',
  'start-desc',
  'duration-asc',
  'duration-desc',
  'range-asc',
  'range-desc',
  'agl-asc',
  'agl-desc',
  'detections-asc',
  'detections-desc',
  'rssi-asc',
  'rssi-desc',
] as const

export type FlightSort = (typeof FLIGHT_SORT_VALUES)[number]

/** Recent first: the last thing that flew is the thing being looked for. */
export const DEFAULT_FLIGHT_SORT: FlightSort = 'start-desc'

export type FlightSortColumn = 'start' | 'duration' | 'range' | 'agl' | 'detections' | 'rssi'

export function parseFlightSort(sort: FlightSort): {
  column: FlightSortColumn
  desc: boolean
} {
  const cut = sort.lastIndexOf('-')
  return { column: sort.slice(0, cut) as FlightSortColumn, desc: sort.endsWith('-desc') }
}

function sortValue(
  track: Track,
  column: FlightSortColumn,
  receiver: ReceiverPosition | null,
): number | null {
  switch (column) {
    case 'start':
      return flightStartMs(track)
    case 'duration':
      return flightDurationS(track)
    case 'range':
      return maxRangeM(track, receiver)
    case 'agl':
      return maxHeightAglM(track)
    case 'detections':
      return track.detection_count
    case 'rssi':
      return track.rssi_dbm ?? null
  }
}

/**
 * Sort flights, missing measurements last in BOTH directions.
 *
 * A track with no height AGL is not the lowest flight of the day; sorting it as
 * if it were would put "we do not know" at the top of "ascending height" and
 * read as a measurement. Absent values therefore sink regardless of direction,
 * which is the convention every other sortable measurement in this app follows.
 */
export function sortFlights(
  tracks: Track[],
  sort: FlightSort,
  receiver: ReceiverPosition | null,
): Track[] {
  const { column, desc } = parseFlightSort(sort)
  // Precomputed: maxRangeM walks up to 4096 points per track, and a comparator
  // is called O(n log n) times.
  const keyed = tracks.map((track) => ({ track, value: sortValue(track, column, receiver) }))
  keyed.sort((a, b) => {
    if (a.value === null && b.value === null) return 0
    if (a.value === null) return 1
    if (b.value === null) return -1
    return desc ? b.value - a.value : a.value - b.value
  })
  return keyed.map((entry) => entry.track)
}
