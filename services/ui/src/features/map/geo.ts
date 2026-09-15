/**
 * GeoJSON builders for the map's line layers.
 *
 * Only *lines* go through GeoJSON sources — trails, and the tether between an
 * aircraft and its operator. Points are DOM markers instead (see live-map.tsx),
 * because a symbol layer needs a sprite and a text label needs glyph PBFs, and
 * shipping neither is what makes the no-tiles fallback genuinely offline.
 */
import type { Position, Track } from '@/lib/api/types'

export function hasPosition(track: Track): track is Track & { current: Position } {
  // `!= null` rather than two comparisons: `current` is optional, so the type
  // is Position | undefined and an explicit `!== null` is dead. The loose
  // check still covers a null if one ever appears on the wire.
  return track.current != null
}

/**
 * Silence longer than this between two recorded positions is a gap in
 * reception, not a leg of the flight.
 *
 * The same 30 s after which fusion marks a track COASTING: the map already
 * says "not being heard" at that point, so its trail should not draw a
 * confident line across the same interval. Measured on 2026-09-15 (DJI, serial
 * ...003045J0): a flight went 762 m out, past Wi-Fi range, was silent for
 * 7m42s, and came back 999 m out. A solid line joining the two ends read as a
 * straight-line dash across a field the aircraft never crossed.
 */
export const TRAIL_GAP_MS = 30_000

export interface TrailGap {
  from: Position
  to: Position
  seconds: number
}

/** The reception gaps in a history, in flight order. */
export function trailGaps(history: Position[]): TrailGap[] {
  const gaps: TrailGap[] = []
  let from: Position | undefined
  for (const to of history) {
    if (from?.at && to.at) {
      const elapsed = Date.parse(to.at) - Date.parse(from.at)
      if (Number.isFinite(elapsed) && elapsed > TRAIL_GAP_MS) {
        gaps.push({ from, to, seconds: Math.round(elapsed / 1000) })
      }
    }
    from = to
  }
  return gaps
}

/**
 * Trails, one feature per track that has at least two history points, plus
 * one dashed feature per reception gap.
 *
 * The heard segments are one MultiLineString carrying the track's own
 * properties, so styling by confidence and state is unchanged. Each gap is its
 * own LineString with `gap: true`, drawn by a separate dashed layer: the
 * aircraft went from one end to the other, but nothing knows how.
 */
export function trailsGeoJson(tracks: Track[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const track of tracks) {
    const history = track.history ?? []
    if (history.length < 2) continue

    const gaps = trailGaps(history)
    const resumesAt = new Set(gaps.map((g) => g.to))
    let leg: GeoJSON.Position[] = []
    const segments: GeoJSON.Position[][] = [leg]
    for (const p of history) {
      if (resumesAt.has(p)) {
        leg = []
        segments.push(leg)
      }
      leg.push([p.lon, p.lat])
    }
    const heard = segments.filter((s) => s.length >= 2)
    if (heard.length > 0) {
      features.push({
        type: 'Feature',
        id: track.track_id,
        properties: {
          track_id: track.track_id,
          confidence: track.confidence,
          state: track.state,
          stale: track.state === 'COASTING',
          gap: false,
        },
        geometry: { type: 'MultiLineString', coordinates: heard },
      })
    }
    gaps.forEach((g, i) => {
      features.push({
        type: 'Feature',
        id: `${track.track_id}-gap-${i}`,
        properties: { track_id: track.track_id, gap: true, gap_s: g.seconds },
        geometry: {
          type: 'LineString',
          coordinates: [
            [g.from.lon, g.from.lat],
            [g.to.lon, g.to.lat],
          ],
        },
      })
    })
  }
  return { type: 'FeatureCollection', features }
}

/**
 * A dashed tether from each aircraft to its operator's ground position.
 *
 * The pairing is the useful bit — "that aircraft is being flown from over there"
 * is information you cannot get from two unconnected dots. Absent `operator` is
 * the normal case for drones that never send a System message, and is simply
 * skipped rather than treated as an error.
 */
export function operatorLinksGeoJson(tracks: Track[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const track of tracks) {
    const operator = track.operator
    if (!operator || !track.current) continue
    features.push({
      type: 'Feature',
      id: `${track.track_id}-operator-link`,
      properties: { track_id: track.track_id },
      geometry: {
        type: 'LineString',
        coordinates: [
          [track.current.lon, track.current.lat],
          [operator.lon, operator.lat],
        ],
      },
    })
  }
  return { type: 'FeatureCollection', features }
}

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

/** Bounding box over everything plottable, so "fit to contacts" can work. */
export function boundsOf(points: { lat: number; lon: number }[]): Bounds | null {
  if (points.length === 0) return null
  let west = 180
  let east = -180
  let south = 90
  let north = -90
  for (const p of points) {
    west = Math.min(west, p.lon)
    east = Math.max(east, p.lon)
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
  }
  return { west, south, east, north }
}

export function plottablePoints(tracks: Track[]): { lat: number; lon: number }[] {
  const points: { lat: number; lon: number }[] = []
  for (const track of tracks) {
    for (const position of track.history ?? []) {
      points.push({ lat: position.lat, lon: position.lon })
    }
    if (track.current) points.push({ lat: track.current.lat, lon: track.current.lon })
    if (track.operator) points.push({ lat: track.operator.lat, lon: track.operator.lon })
  }
  return points
}

/** Great-circle distance in metres. Used for the "N m away" readouts. */
export function distanceMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from a to b, in degrees clockwise from north. */
export function bearingDegrees(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}
