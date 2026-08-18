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
 *
 * `maxAgeMs` bounds how old a report may be and still count as traffic that is
 * up there now. The API is asked for the same window, so this is a second line
 * rather than the only one — but it is the line that matters if the API ever
 * answers without honouring `since`, and plotting a sixteen-hour-old aircraft
 * as current is exactly the kind of confident wrongness this project avoids
 * elsewhere. Omit it to keep every detection, which is what the tests for the
 * collapsing behaviour itself want.
 */
export function aircraftFromDetections(
  detections: Detection[],
  maxAgeMs?: number,
  now: number = Date.now(),
): Detection[] {
  const newestByIcao = new Map<string, Detection>()
  const unattributed: Detection[] = []

  for (const detection of detections) {
    if (maxAgeMs !== undefined) {
      const at = Date.parse(detection.ts)
      // A timestamp that will not parse is kept rather than dropped: it is a
      // real report with a broken clock, and discarding contacts silently is
      // worse than showing one with an odd time.
      if (Number.isFinite(at) && now - at > maxAgeMs) continue
    }
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
