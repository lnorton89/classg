import type { Detection } from '@/lib/api/schema.gen'

/**
 * Collapse ADS-B detections to one entry per aircraft, newest first.
 *
 * The detections feed is a stream of reports, not a list of contacts: a single
 * airliner overhead produces one detection per SBS message, so 200 rows off the
 * API were four aircraft — one of them 132 times. Rendered straight, the
 * contacts panel repeated the same registration down the page and the "Manned
 * traffic" count read 200 for four aeroplanes, which is not a cosmetic problem
 * on a display whose whole job is telling an operator what is up there.
 *
 * The map already keyed its manned markers by ICAO and so drew four; the list
 * and the count are what disagreed with it.
 *
 * Detections without an ICAO cannot be attributed to an aircraft and are kept
 * as individual entries rather than dropped — they are still something the
 * receiver heard, and silently discarding contacts is the failure mode this
 * project likes least.
 */
export function aircraftFromDetections(detections: Detection[]): Detection[] {
  const newestByIcao = new Map<string, Detection>()
  const unattributed: Detection[] = []

  for (const detection of detections) {
    const icao = detection.adsb?.icao
    if (!icao) {
      unattributed.push(detection)
      continue
    }
    const seen = newestByIcao.get(icao)
    if (!seen || detection.ts > seen.ts) {
      newestByIcao.set(icao, detection)
    }
  }

  // ISO-8601 with a fixed offset sorts lexically in time order, which is why
  // `ts` is compared as a string here and everywhere else in the app.
  return [...newestByIcao.values(), ...unattributed].sort((a, b) => (a.ts < b.ts ? 1 : -1))
}
