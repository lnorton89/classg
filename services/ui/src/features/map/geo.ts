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
  return track.current !== undefined && track.current !== null
}

/** Trails, one LineString per track that has at least two history points. */
export function trailsGeoJson(tracks: Track[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const track of tracks) {
    const history = track.history ?? []
    if (history.length < 2) continue
    features.push({
      type: 'Feature',
      id: track.track_id,
      properties: {
        track_id: track.track_id,
        confidence: track.confidence,
        state: track.state,
        stale: track.state === 'COASTING',
      },
      geometry: {
        type: 'LineString',
        coordinates: history.map((p) => [p.lon, p.lat]),
      },
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
