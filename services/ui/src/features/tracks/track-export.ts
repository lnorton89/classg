/**
 * Turn a track's recorded flight into files another tool can open.
 *
 * The detail page renders 512-point paths and 500-sample RSSI series that,
 * until this module, could leave the app only as a screenshot. An
 * evidence-review tool whose docs describe ground-truth workflows owes its
 * data a machine-readable exit: CSV for spreadsheets, GeoJSON for the mapping
 * tools that decimal-degree coordinates are already formatted for. The Event
 * log's NDJSON/CSV export set the precedent; this follows it.
 *
 * Timestamps are emitted as the ISO strings the API supplied — UTC, like the
 * share card — because these files outlive the session that made them, and a
 * bare local clock with no offset is the one format guaranteed to be misread.
 */
import type { Position, Track } from '@/lib/api/types'

import type { RssiSample } from './rssi-samples'

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

/** Chronological rows, one per reported point, empty cells for never-reported fields. */
export function positionsCsv(history: Position[]): string {
  const header = 'at,lat,lon,alt_geodetic_m,height_agl_m,speed_mps,track_deg'
  const rows = history.map((p) =>
    [
      csvField(p.at ?? ''),
      String(p.lat),
      String(p.lon),
      num(p.alt_geodetic_m),
      num(p.height_agl_m),
      num(p.speed_mps),
      num(p.track_deg),
    ].join(','),
  )
  return [header, ...rows, ''].join('\n')
}

/**
 * One LineString for the flight, plus a Point when the pilot's ground position
 * was broadcast. Coordinates are [lon, lat, alt?] per the GeoJSON spec — the
 * reverse of how this UI displays them, which is exactly why the export exists
 * as code rather than as an operator retyping.
 */
export function pathGeoJson(track: Track, history: Position[]): string {
  const coords = history.map((p) =>
    p.alt_geodetic_m === null || p.alt_geodetic_m === undefined
      ? [p.lon, p.lat]
      : [p.lon, p.lat, p.alt_geodetic_m],
  )
  const features: object[] = [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        track_id: track.track_id,
        serial: track.identity?.serial ?? null,
        vendor: track.identity?.vendor ?? null,
        state: track.state,
        first_seen: track.first_seen,
        last_seen: track.last_seen,
        detection_count: track.detection_count,
      },
    },
  ]
  if (track.operator) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [track.operator.lon, track.operator.lat] },
      properties: { role: 'operator' },
    })
  }
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2)
}

export function rssiCsv(samples: RssiSample[]): string {
  const rows = samples.map((s) => `${csvField(s.ts)},${String(s.rssi)}`)
  return ['at,rssi_dbm', ...rows, ''].join('\n')
}

/** classg-track-<identity>-…, filesystem-safe whatever the serial contains. */
export function exportBasename(track: Track): string {
  const identity = track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id
  return `classg-track-${identity.replaceAll(/[^A-Za-z0-9._-]+/g, '-')}`
}
