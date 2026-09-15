/**
 * Projection for the row-sized path thumbnail.
 *
 * Strava's trick, applied to flights: a list of near-identical rows becomes
 * scannable the moment each row carries the shape of its route, because a
 * shape is a fingerprint in a way that six decimal places of latitude is not.
 *
 * Deliberately not MapLibre. This draws forty of these per screen on a Pi, and
 * a basemap under a 72×28 box would be neither legible nor free — the shape is
 * the whole payload, so it is one `<polyline>` and nothing else.
 */
import type { ReceiverPosition } from '@/lib/api/types'

export interface LatLon {
  lat: number
  lon: number
}

export interface Point {
  x: number
  y: number
}

export interface PathShape {
  path: Point[]
  operator: Point | null
  /** Present only when a receiver position anchored the projection. */
  receiver: Point | null
}

export interface ProjectOptions {
  width: number
  height: number
  padding: number
  /**
   * Anchors the drawing so the receiver sits dead centre. With it, two
   * thumbnails of the same aircraft are comparable — one flight visibly went
   * further than the other. Without it each is bbox-fitted and only the shape
   * carries over, which is why the fallback is stated in the tooltip.
   */
  receiver?: ReceiverPosition | null
  operator?: LatLon | null
}

/**
 * Every nth point, first and last always kept.
 *
 * Not Douglas-Peucker. At 72 px wide, a 4096-point history and its 64-point
 * stride are the same picture, and uniform decimation is a single pass with no
 * recursion — which matters when the closed list renders a hundred rows on a
 * Raspberry Pi. The detail page draws the real path.
 */
export function simplifyPath<T>(points: T[], maxPoints: number): T[] {
  if (maxPoints < 2 || points.length <= maxPoints) return points
  const stride = Math.ceil(points.length / (maxPoints - 1))
  const kept: T[] = []
  for (let i = 0; i < points.length; i += stride) {
    const point = points[i]
    if (point !== undefined) kept.push(point)
  }
  const last = points[points.length - 1]
  if (last !== undefined && kept[kept.length - 1] !== last) kept.push(last)
  return kept
}

/**
 * Metres-ish local plane. The cosine keeps a degree of longitude the right
 * fraction of a degree of latitude, so a thumbnail of an east-west leg is not
 * stretched at 55°N; y is negated because SVG counts downwards.
 */
function planar(point: LatLon, centre: LatLon): Point {
  const kx = Math.cos((centre.lat * Math.PI) / 180)
  return { x: (point.lon - centre.lon) * kx, y: -(point.lat - centre.lat) }
}

/**
 * Project a flight into a box, or null when there is nothing to draw.
 *
 * One point is not a path and returns null: a single dot in a column headed
 * "Path" reads as a rendering fault rather than as "this contact never moved".
 */
export function projectPath(history: LatLon[], options: ProjectOptions): PathShape | null {
  const { width, height, padding, receiver = null, operator = null } = options
  if (history.length < 2) return null

  const extras = operator ? [operator] : []
  const all = [...history, ...extras]
  const centre: LatLon = receiver ?? boxCentre(all)

  const projected = all.map((point) => planar(point, centre))
  // A single scale for both axes, and a symmetric half-extent, so the drawing
  // is the flight's shape rather than the flight stretched to fill the box.
  let half = 0
  for (const point of projected) {
    half = Math.max(half, Math.abs(point.x), Math.abs(point.y))
  }
  const box = Math.min(width, height) - 2 * padding
  const scale = half > 0 ? box / (2 * half) : 0

  const toScreen = (point: Point): Point => ({
    x: width / 2 + point.x * scale,
    y: height / 2 + point.y * scale,
  })

  return {
    path: history.map((point) => toScreen(planar(point, centre))),
    operator: operator ? toScreen(planar(operator, centre)) : null,
    receiver: receiver ? { x: width / 2, y: height / 2 } : null,
  }
}

function boxCentre(points: LatLon[]): LatLon {
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const point of points) {
    west = Math.min(west, point.lon)
    east = Math.max(east, point.lon)
    south = Math.min(south, point.lat)
    north = Math.max(north, point.lat)
  }
  return { lat: (south + north) / 2, lon: (west + east) / 2 }
}

/** `"x,y x,y"` for an SVG `points` attribute, rounded to a tenth of a pixel. */
export function polylinePoints(points: Point[]): string {
  return points.map((point) => `${round(point.x)},${round(point.y)}`).join(' ')
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
