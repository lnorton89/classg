import type { Detection, Position } from '@/lib/api/types'

/**
 * The flown path, rebuilt from the detections that recorded it.
 *
 * A track document carries its own `history`, and for a live aircraft that is
 * the right source: it arrives on the websocket with every update and needs no
 * second request. It is also a BOUNDED ring buffer — fusion keeps the most
 * recent HistoryDepth points and drops the oldest — so on a long flight the
 * start of the path is gone from the track while the flight is still being
 * recorded. That is correct for a live trail and wrong for a detail page, whose
 * whole job is to show what happened.
 *
 * Detections are the record underneath it. Each one carries the position it
 * reported, they are never rewritten, and the detail page already fetches them
 * for the RSSI chart. Measured on a real flight (2026-08-21): the stored track
 * had lost its first 36.8 seconds, and the detections still had every one.
 *
 * Falls back to the track's own history when there is nothing to rebuild from —
 * an ADS-B track whose detections carry no position, or any track older than
 * the detection retention window, where `history` is the only surviving record.
 */
export function flightPath(detections: Detection[], history: Position[]): Position[] {
  const fromDetections = detections
    .filter(
      (d): d is Detection & { position: { lat: number; lon: number } } =>
        typeof d.position?.lat === 'number' && typeof d.position.lon === 'number',
    )
    // Detections come back newest-first (the contract orders by timestamp DESC).
    // A path drawn in that order is the same shape, but every consumer that
    // treats point[0] as the start -- the "took off here" marker, the elapsed
    // readout -- would have it backwards.
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .map((d) => ({
      lat: d.position.lat,
      lon: d.position.lon,
      alt_geodetic_m: d.position.alt_geodetic_m ?? null,
      height_agl_m: d.position.height_agl_m ?? null,
      speed_mps: d.kinematics?.speed_mps ?? null,
      track_deg: d.kinematics?.track_deg ?? null,
      at: d.ts,
    }))

  // Only when it is genuinely better. One positioned detection is not a path,
  // and preferring it over a track history that has several points would trade
  // a drawn route for a dot.
  return fromDetections.length > history.length ? fromDetections : history
}
