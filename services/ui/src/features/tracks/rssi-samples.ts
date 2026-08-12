import type { Detection } from '@/lib/api/types'

export interface RssiSample {
  ts: string
  rssi: number
}

// Kept out of rssi-chart.tsx so that file exports only its component. The
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
