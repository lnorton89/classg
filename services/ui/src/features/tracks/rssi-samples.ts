import type { Detection } from '@/lib/api/types'

export interface RssiSample {
  ts: string
  rssi: number
}

// Kept out of the chart components so those files export only components. The
// filter is a type guard rather than a `!`: a detection without an RSSI is
// ordinary — ADS-B carries no signal strength — so those are dropped, not
// coerced to zero, which would draw a line at the bottom of the chart implying
// a signal that was never measured.
export function samplesFromDetections(detections: Detection[]): RssiSample[] {
  return detections
    .filter(
      (d): d is Detection & { rf: { rssi_dbm: number } } => typeof d.rf?.rssi_dbm === 'number',
    )
    .map((d) => ({ ts: d.ts, rssi: d.rf.rssi_dbm }))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

/**
 * The same samples, split by the radio that took them.
 *
 * Pooling them draws one trace whose steps are the handover between adapters
 * rather than the aircraft moving: on a two-radio unit the ALFA and the TP-Link
 * differ in antenna and gain, so a sample from one is not comparable with a
 * sample from the other (see features/tracks/receivers.tsx). One lane per
 * receiver is the only form in which the numbers mean anything.
 *
 * Insertion-ordered by first appearance, so the trace order matches the order
 * the detections arrived rather than an alphabetical sort of sensor ids.
 */
export function samplesByReceiver(detections: Detection[]): Map<string, RssiSample[]> {
  const bySensor = new Map<string, RssiSample[]>()
  for (const detection of detections) {
    const rssi = detection.rf?.rssi_dbm
    if (typeof rssi !== 'number') continue
    const existing = bySensor.get(detection.sensor_id)
    const sample = { ts: detection.ts, rssi }
    if (existing) existing.push(sample)
    else bySensor.set(detection.sensor_id, [sample])
  }
  for (const samples of bySensor.values()) {
    samples.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  }
  return bySensor
}
