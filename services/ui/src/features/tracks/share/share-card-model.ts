/**
 * Shapes a `Track` into the flat model the share card draws.
 *
 * Kept separate from the SVG so the decisions that matter — what redaction
 * actually removes, how a path is normalised, what counts as unknown — are
 * testable without a DOM or a canvas.
 *
 * The card is a summary someone may send to a neighbour or a council, so it
 * inherits the same rule as the rest of the UI: never render a placeholder that
 * could be mistaken for a measurement. An absent altitude is an em dash on the
 * card exactly as it is on the page.
 */
import { EMPTY, formatConfidence, formatLatLon } from '@/lib/format'
import type { Position, Track } from '@/lib/api/types'

import type { RssiSample } from '../rssi-samples'

/** Points in the sketch. More than this and the polyline is drawing noise. */
const MAX_PATH_POINTS = 120

export interface CardPathPoint {
  /** 0..1 across the sketch box, already flipped for SVG's y-down space. */
  x: number
  y: number
}

export interface CardPath {
  points: CardPathPoint[]
  /** Longest side of the bounding box, in metres. Null when it cannot be sized. */
  spanMetres: number | null
  /** True when every point is the same spot — a parked aircraft, not a flight. */
  stationary: boolean
}

export interface CardSignal {
  /** 0..1 within the plot box, y already flipped for SVG. */
  points: CardPathPoint[]
  minRssi: number
  maxRssi: number
  peakRssi: number
}

export interface ShareCardModel {
  title: string
  trackId: string
  state: string
  vendor: string
  uaType: string
  modelHint: string
  confidence: number
  confidenceLabel: string
  detectionCount: number
  firstSeen: string
  lastSeen: string
  durationLabel: string
  evidenceClasses: string[]
  sensorKinds: string[]
  /** Null when redacted or never reported. */
  coordinates: string | null
  altitudeM: number | null
  heightAglM: number | null
  path: CardPath | null
  signal: CardSignal | null
  peakRssiLabel: string
  /** Title-cased "DJI Multirotor" for the card's headline. */
  headline: string
  /** Date and clock range, e.g. "16 Aug 2026, 03:48 – 03:49 UTC". */
  seenLabel: string
  /** "Moved ~120 m" / "Stationary" / em dash when there is no history. */
  movementLabel: string
  redacted: boolean
}

/**
 * The card's headline: what was seen, in the register of a title.
 *
 * The API carries identity in lower case (`dji`, `multirotor`) because that is
 * how the fingerprint rules are written, and set as a 76px headline that reads
 * as a shell prompt rather than a finding. Short tokens are upper-cased because
 * the vendors that fit are acronyms — DJI, not Dji — while longer names get
 * ordinary title case, so Parrot and Skydio are not shouted.
 */
export function formatHeadline(vendor: string, uaType: string): string {
  const word = (value: string) =>
    value.length <= 3 ? value.toUpperCase() : value.charAt(0).toUpperCase() + value.slice(1)
  const titled = (value: string) => value.split(/\s+/).filter(Boolean).map(word).join(' ')

  const parts = [vendor, uaType].filter((v) => v && v !== EMPTY).map(titled)
  return parts.length ? parts.join(' ') : 'Unidentified aircraft'
}

/**
 * When the contact was seen, in UTC.
 *
 * UTC and not the viewer's zone: the card outlives the session that made it and
 * is read by people elsewhere, so a bare local clock with no offset is the one
 * format guaranteed to be misread. The console itself stays in the operator's
 * chosen zone — this is the copy that travels.
 */
export function formatSeen(firstSeen: string, lastSeen: string): string {
  const start = new Date(firstSeen)
  const end = new Date(lastSeen)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return EMPTY

  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(start)
  const clock = (value: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      hour12: false,
    }).format(value)

  return `${day}, ${clock(start)}–${clock(end)} UTC`
}

/**
 * Whether the ground track is worth drawing.
 *
 * A parked aircraft still reports a wandering position — the DJI contact on
 * 2026-08-16 drifted about 2 m across 262 points — and plotting that fills the
 * panel with a squiggle that looks like a flight. Below this it is GPS noise,
 * and saying "stationary" is both true and more useful than a shape.
 */
export const MIN_MOVEMENT_M = 25

/**
 * RSSI over time, normalised for the card's sparkline.
 *
 * This replaced the ground track as the card's chart. Signal strength is
 * meaningful for every track that carries it, including the stationary ones,
 * and it answers the question a reader actually has — was this close or far —
 * whereas an unscaled, unreferenced path answers nothing without a map.
 */
export function buildSignal(samples: RssiSample[]): CardSignal | null {
  if (samples.length < 2) return null

  const values = samples.map((s) => s.rssi)
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  // Clamp to plausible receiver range, and round outward, so one bad sample
  // cannot flatten the trace. Mirrors rssi-chart.tsx deliberately: the card and
  // the page must not disagree about the shape of the same data.
  const minRssi = Math.max(-110, Math.floor((rawMin - 3) / 5) * 5)
  const maxRssi = Math.min(0, Math.ceil((rawMax + 3) / 5) * 5)
  const range = Math.max(1, maxRssi - minRssi)

  const times = samples.map((s) => Date.parse(s.ts))
  const minTime = Math.min(...times)
  const span = Math.max(1, Math.max(...times) - minTime)

  const thinned = downsample(samples, MAX_PATH_POINTS)
  return {
    points: thinned.map((s) => ({
      x: (Date.parse(s.ts) - minTime) / span,
      // Stronger signal is a SMALLER negative number and belongs at the top.
      y: 1 - (s.rssi - minRssi) / range,
    })),
    minRssi,
    maxRssi,
    peakRssi: rawMax,
  }
}

interface LatLon {
  lat: number
  lon: number
}

function metresBetween(a: LatLon, b: LatLon): number {
  // Equirectangular approximation. The sketch spans metres-to-kilometres, where
  // the error against haversine is far below the width of the drawn line.
  const R = 6_371_000
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const dLat = (b.lat - a.lat) * (Math.PI / 180)
  const dLon = (b.lon - a.lon) * (Math.PI / 180)
  const x = dLon * Math.cos(lat)
  return Math.hypot(x, dLat) * R
}

/** Evenly thin a list without dropping its endpoints. */
function downsample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items
  const step = (items.length - 1) / (limit - 1)
  const thinned: T[] = []
  for (let i = 0; i < limit; i += 1) {
    const item = items[Math.round(i * step)]
    if (item !== undefined) thinned.push(item)
  }
  return thinned
}

export function buildPath(history: Position[]): CardPath | null {
  const points = history.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
  if (points.length < 2) return null

  const sampled = downsample(points, MAX_PATH_POINTS)
  const lats = sampled.map((p) => p.lat)
  const lons = sampled.map((p) => p.lon)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)

  const latSpan = maxLat - minLat
  const lonSpan = maxLon - minLon
  // A track that never moved has zero extent in both axes. Normalising that
  // would divide by zero and scatter the points; it is also worth SAYING,
  // because a dot and a squiggle mean very different things about a flight.
  const stationary = latSpan === 0 && lonSpan === 0

  const spanMetres = stationary
    ? 0
    : metresBetween({ lat: minLat, lon: minLon }, { lat: maxLat, lon: maxLon })

  if (stationary) {
    return { points: [{ x: 0.5, y: 0.5 }], spanMetres: 0, stationary: true }
  }

  // Preserve aspect ratio: scaling each axis to fill the box would stretch a
  // straight line into a diagonal and turn a hover into a wide sweep.
  const scale = Math.max(latSpan, lonSpan)
  const xOffset = (scale - lonSpan) / 2
  const yOffset = (scale - latSpan) / 2

  return {
    points: sampled.map((p) => ({
      x: (p.lon - minLon + xOffset) / scale,
      // SVG y grows downward; north must end up at the top.
      y: 1 - (p.lat - minLat + yOffset) / scale,
    })),
    spanMetres,
    stationary: false,
  }
}

export function formatDuration(firstSeen?: string, lastSeen?: string): string {
  if (!firstSeen || !lastSeen) return EMPTY
  const ms = Date.parse(lastSeen) - Date.parse(firstSeen)
  if (!Number.isFinite(ms) || ms < 0) return EMPTY
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function buildShareCardModel(
  track: Track,
  redacted: boolean,
  rssiSamples: RssiSample[] = [],
): ShareCardModel {
  const current = track.current
  const evidence = track.evidence ?? []
  const signal = buildSignal(rssiSamples)
  const rawPath = buildPath(track.history ?? [])
  // Only a genuine flight gets drawn. See MIN_MOVEMENT_M.
  const path =
    rawPath && !rawPath.stationary && (rawPath.spanMetres ?? 0) >= MIN_MOVEMENT_M
      ? rawPath
      : null

  // Redaction drops the coordinates outright rather than rounding them. A
  // coarsened pair still reads as a measurement and invites someone to plug it
  // into a map; "withheld" cannot be misread that way.
  //
  // The path sketch survives redaction on purpose: it is normalised to its own
  // bounding box with no basemap, north arrow, or origin, so it describes the
  // SHAPE of a flight without placing it anywhere on earth.
  const coordinates = redacted || !current ? null : formatLatLon(current.lat, current.lon)

  return {
    title: track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id,
    trackId: track.track_id,
    state: track.state,
    vendor: track.identity?.vendor ?? EMPTY,
    uaType: track.identity?.ua_type ?? EMPTY,
    modelHint: track.identity?.model_hint ?? EMPTY,
    confidence: track.confidence,
    confidenceLabel: formatConfidence(track.confidence),
    detectionCount: track.detection_count,
    firstSeen: track.first_seen,
    lastSeen: track.last_seen,
    durationLabel: formatDuration(track.first_seen, track.last_seen),
    evidenceClasses: [...new Set(evidence.map((e) => e.class))].sort(),
    sensorKinds: [...new Set(evidence.map((e) => e.sensor_kind))].sort(),
    coordinates,
    altitudeM: redacted ? null : (current?.alt_geodetic_m ?? null),
    heightAglM: current?.height_agl_m ?? null,
    path,
    signal,
    peakRssiLabel: signal ? `${signal.peakRssi} dBm` : EMPTY,
    headline: formatHeadline(track.identity?.vendor ?? EMPTY, track.identity?.ua_type ?? EMPTY),
    seenLabel: formatSeen(track.first_seen, track.last_seen),
    // The ground track as a sentence rather than a plot. "Stationary" is the
    // more useful reading for a parked aircraft, and it cannot be mistaken for
    // a flight the way a jitter squiggle can.
    movementLabel: !rawPath
      ? EMPTY
      : path
        ? `Moved ~${Math.round(path.spanMetres ?? 0)} m`
        : 'Stationary',
    redacted,
  }
}
