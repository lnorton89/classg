/**
 * Track fixtures.
 *
 * Grounded in docs/ops/04-calibration.md — the only real observation this project
 * has. Specifically:
 *
 *   - The DJI Mini 5 Pro broadcasts **Class A only** over Wi-Fi Beacon. No Class B.
 *     That is the *expected* result, not a bug, so the headline fixture has a
 *     confidence of 0.60 rather than a flattering 0.94.
 *   - Its transmitter OUI is 8c:1e:d9, which is NOT in the fingerprint list, so
 *     there is no Class C evidence for it either.
 *   - Manufacturer code 1581 (= DJI) comes from the serial, not the OUI.
 *   - RSSI at ~10 m was -35 dBm.
 *
 * The A+B+C track is a hypothetical older Wi-Fi-link DJI, included because it is
 * the worked example in data-model.md (0.82) and because the UI must show that
 * three classes of evidence still do not reach certainty.
 */
import { noisyOr } from '@/lib/detection-classes'
import type { Evidence, Position, Track } from '@/lib/api/types'

import { isoAt, offsetLatLon, SITE } from './site'

interface PathOptions {
  points: number
  /** Seconds between samples. */
  stepS: number
  startNorthM: number
  startEastM: number
  headingDeg: number
  speedMps: number
  heightM: number
  /** Last sample lands at `endOffsetS`; earlier ones are before it. */
  endOffsetS: number
  climbMps?: number
}

function flightPath(options: PathOptions): Position[] {
  const { points, stepS, startNorthM, startEastM, headingDeg, speedMps, heightM } = options
  const rad = (headingDeg * Math.PI) / 180
  return Array.from({ length: points }, (_, i) => {
    const travelled = speedMps * stepS * i
    const north = startNorthM + Math.cos(rad) * travelled
    const east = startEastM + Math.sin(rad) * travelled
    const { lat, lon } = offsetLatLon(SITE.lat, SITE.lon, north, east)
    const height = heightM + (options.climbMps ?? 0) * stepS * i
    return {
      lat,
      lon,
      alt_geodetic_m: Math.round((SITE.elevationM + height) * 10) / 10,
      height_agl_m: Math.round(height * 10) / 10,
      speed_mps: speedMps,
      track_deg: headingDeg,
      at: isoAt(options.endOffsetS - stepS * (points - 1 - i)),
    }
  })
}

function evidence(
  parts: {
    class: Evidence['class']
    sensor: Evidence['sensor_kind']
    weight: number
    count: number
  }[],
  lastSeenOffsetS: number,
): Evidence[] {
  return parts.map((p) => ({
    class: p.class,
    sensor_kind: p.sensor,
    weight: p.weight,
    count: p.count,
    last_seen: isoAt(lastSeenOffsetS),
  }))
}

// ---------------------------------------------------------------------------
// 1. The real aircraft: DJI Mini 5 Pro, Class A only.
// ---------------------------------------------------------------------------

const mini5History = flightPath({
  points: 48,
  stepS: 2,
  startNorthM: -40,
  startEastM: 30,
  headingDeg: 312,
  speedMps: 6.4,
  heightM: 62,
  climbMps: 0.15,
  endOffsetS: -1,
})

const mini5Evidence = evidence([{ class: 'A', sensor: 'wifi', weight: 0.6, count: 402 }], -1)

export const trackMini5Pro: Track = {
  schema_version: '1.0',
  track_id: '01J8XR4M9K3QW7A2ZC5NDVB1TP',
  state: 'CONFIRMED',
  first_seen: isoAt(-471),
  last_seen: isoAt(-1),
  detection_count: 402,
  identity: {
    // 1581 = DJI (ANSI/CTA-2063-A), then 'F' + 15 characters.
    serial: '1581F5NCC2400A7YZ12K',
    macs: ['8c:1e:d9:4a:22:07'],
    // Deliberately null: the calibration record says this OUI is not in our
    // fingerprint list and the vendor is unverified from the transmitter alone.
    vendor: null,
    manufacturer_code: '1581',
    model_hint: null,
    operator_id: null,
    ua_type: 'multirotor',
  },
  confidence: noisyOr([0.6]),
  evidence: mini5Evidence,
  current: mini5History[mini5History.length - 1],
  history: mini5History,
  operator: {
    ...offsetLatLon(SITE.lat, SITE.lon, -55, 18),
    alt_geodetic_m: SITE.elevationM + 1.6,
    height_agl_m: null,
    speed_mps: null,
    track_deg: null,
    at: isoAt(-1),
  },
  rssi_dbm: -51,
  adsb_correlated: false,
}

// ---------------------------------------------------------------------------
// 2. Hypothetical older Wi-Fi-link DJI: A + B + C -> 0.82 (data-model.md example)
// ---------------------------------------------------------------------------

const legacyHistory = flightPath({
  points: 30,
  stepS: 3,
  startNorthM: 210,
  startEastM: -180,
  headingDeg: 95,
  speedMps: 11.2,
  heightM: 108,
  climbMps: -0.4,
  endOffsetS: -4,
})

export const trackLegacyDji: Track = {
  schema_version: '1.0',
  track_id: '01J8XR5T2B8HF0KQ3M6RWYX4EN',
  state: 'CONFIRMED',
  first_seen: isoAt(-1284),
  last_seen: isoAt(-4),
  detection_count: 471,
  identity: {
    serial: '1581F3XKD9910B2QW77M',
    macs: ['60:60:1f:aa:bb:cc', '3a:7d:11:0e:4f:92'],
    vendor: 'dji',
    manufacturer_code: '1581',
    model_hint: 'Mini 3 Pro',
    operator_id: null,
    ua_type: 'multirotor',
  },
  confidence: noisyOr([0.6, 0.5, 0.1]),
  evidence: evidence(
    [
      { class: 'A', sensor: 'wifi', weight: 0.6, count: 402 },
      { class: 'B', sensor: 'wifi', weight: 0.5, count: 398 },
      { class: 'C', sensor: 'wifi', weight: 0.1, count: 471 },
    ],
    -4,
  ),
  current: legacyHistory[legacyHistory.length - 1],
  history: legacyHistory,
  operator: {
    ...offsetLatLon(SITE.lat, SITE.lon, 190, -240),
    alt_geodetic_m: SITE.elevationM + 1.7,
    height_agl_m: null,
    speed_mps: null,
    track_deg: null,
    at: isoAt(-4),
  },
  rssi_dbm: -68,
  adsb_correlated: false,
}

// ---------------------------------------------------------------------------
// 3. OUI-only hint. Confidence 0.10, TENTATIVE, and NO position at all.
//    This is the false-positive case the weighting exists to defuse, and it is
//    also the "track that cannot be plotted" case the map must handle.
// ---------------------------------------------------------------------------

export const trackOuiOnly: Track = {
  schema_version: '1.0',
  track_id: '01J8XR6Q4C1JD5NPT8V0YZ3KAF',
  state: 'TENTATIVE',
  first_seen: isoAt(-38),
  last_seen: isoAt(-6),
  detection_count: 12,
  identity: {
    serial: null,
    macs: ['60:60:1f:3d:9a:c1'],
    vendor: 'dji',
    manufacturer_code: null,
    model_hint: null,
    operator_id: null,
    ua_type: null,
  },
  confidence: noisyOr([0.1]),
  evidence: evidence([{ class: 'C', sensor: 'wifi', weight: 0.1, count: 12 }], -6),
  history: [],
  operator: null,
  rssi_dbm: -77,
  adsb_correlated: false,
}

// ---------------------------------------------------------------------------
// 4. COASTING: last seen 47 s ago, past the 30 s coast threshold. Has a last
//    known position, which the map must render as stale rather than current.
//    Also has NO operator field at all — the absent case must keep working even
//    now that operator location is exposed by default.
// ---------------------------------------------------------------------------

const coastingHistory = flightPath({
  points: 20,
  stepS: 2,
  startNorthM: -320,
  startEastM: -260,
  headingDeg: 30,
  speedMps: 4.1,
  heightM: 44,
  endOffsetS: -47,
})

export const trackCoasting: Track = {
  schema_version: '1.0',
  track_id: '01J8XR7H6D2KE9RSU1W4XB5MCG',
  state: 'COASTING',
  first_seen: isoAt(-206),
  last_seen: isoAt(-47),
  detection_count: 96,
  identity: {
    serial: '1596F1PQ4471C8ZZ01AB',
    macs: ['b4:2e:99:07:1c:3d'],
    vendor: null,
    manufacturer_code: '1596',
    model_hint: null,
    operator_id: 'CHE-OP-0042',
    ua_type: 'multirotor',
  },
  confidence: noisyOr([0.6]),
  evidence: evidence([{ class: 'A', sensor: 'wifi', weight: 0.6, count: 96 }], -47),
  current: coastingHistory[coastingHistory.length - 1],
  history: coastingHistory,
  // `operator` intentionally omitted, not null: the API drops the key entirely
  // when the drone never broadcast a System message.
  rssi_dbm: -83,
  adsb_correlated: false,
}

export const TRACKS: Track[] = [trackMini5Pro, trackLegacyDji, trackOuiOnly, trackCoasting]

/** Used by the "healthy but quiet sky" scenario — genuinely nothing flying. */
export const NO_TRACKS: Track[] = []
