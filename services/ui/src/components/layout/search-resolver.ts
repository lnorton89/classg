/**
 * What a string typed into the header search box means.
 *
 * Split out of the component because it is the part that can be wrong in a way
 * nobody notices: an operator reads a serial off the radio, types it, and the
 * box has to land on that aircraft's flights rather than on a list that happens
 * to contain the substring. Rendering it is a listbox; deciding it is this
 * file, and this file has tests.
 *
 * It resolves only against what the console already knows — the track cache,
 * the aircraft labels, the sensor list. Nothing here fetches, and no endpoint
 * was added for it: a search that waits on the network is a search an operator
 * stops using.
 */
import type { AircraftLabel, SensorHealth, Track } from '@/lib/api/types'

export type SearchHitKind = 'track' | 'serial' | 'label' | 'mac' | 'sensor'

/**
 * Where a hit goes, in terms this module can express without importing the
 * router. The component turns it into `Link` props.
 */
export type SearchTarget =
  | { kind: 'track'; trackId: string }
  | { kind: 'flights'; q: string }
  | { kind: 'sensor'; sensorId: string }

export interface SearchHit {
  /** Stable within one result list, for React keys and `aria-activedescendant`. */
  id: string
  kind: SearchHitKind
  /** The row's headline — the thing that matched. */
  label: string
  /** A qualifier: the serial behind a label, the vendor behind a MAC. */
  detail?: string
  target: SearchTarget
}

/** What each kind is called in the result list. An unlabelled hit is a guess. */
export const SEARCH_KIND_LABEL: Record<SearchHitKind, string> = {
  track: 'Flight',
  serial: 'Serial',
  label: 'Aircraft',
  mac: 'MAC',
  sensor: 'Sensor',
}

export interface SearchIndex {
  /** Every track id the console has seen this session. */
  trackIds: string[]
  /** One entry per distinct broadcast serial, with the operator's label if there is one. */
  serials: { value: string; vendor?: string; label?: string }[]
  /** MACs, including those belonging to a serial — an operator reads whichever is to hand. */
  macs: { value: string; vendor?: string }[]
  sensors: { id: string; kind?: string }[]
}

/**
 * A ULID, which is what a track id is.
 *
 * Deliberately not anchored to Crockford's first-character rule: a
 * hand-retyped id with a transposed leading digit should still be offered as a
 * flight to open — the route will say "not found", which is a better answer
 * than silently treating 26 characters of base32 as a serial substring.
 */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i

/** Match quality. Lower sorts first; `null` is "does not match at all". */
type Rank = 0 | 1 | 2 | null

function rankOf(needle: string, haystack: string): Rank {
  const hay = haystack.toLowerCase()
  if (hay === needle) return 0
  if (hay.startsWith(needle)) return 1
  return hay.includes(needle) ? 2 : null
}

/**
 * The same MAC gets read off a screen as `a4:2b:b0:…` and typed as
 * `a42bb0…`, so both spellings have to reach the same aircraft. Only
 * separators are stripped — a MAC is hex, so nothing else can be lost.
 */
function normaliseMac(value: string): string {
  return value.replaceAll(/[:\-.\s]/g, '').toLowerCase()
}

/** Which kind wins when two hits rank equally. */
const KIND_ORDER: Record<SearchHitKind, number> = {
  track: 0,
  serial: 1,
  label: 2,
  mac: 3,
  sensor: 4,
}

interface Ranked {
  rank: Exclude<Rank, null>
  hit: SearchHit
}

export const SEARCH_RESULT_LIMIT = 8

/**
 * Resolve a typed string to somewhere to go.
 *
 * Empty in, empty out: an empty box shows no list rather than the whole index,
 * because "everything" is what the command palette is for.
 */
export function resolveSearch(
  query: string,
  index: SearchIndex,
  limit: number = SEARCH_RESULT_LIMIT,
): SearchHit[] {
  const raw = query.trim()
  if (raw.length === 0) return []
  const needle = raw.toLowerCase()

  const ranked: Ranked[] = []

  // A pasted ULID is unambiguous, so it is offered whether or not this browser
  // has seen the track: the detail route already has a "not found" page that
  // says more than an empty result list can.
  if (ULID.test(raw)) {
    ranked.push({
      rank: 0,
      hit: {
        id: `track:${raw}`,
        kind: 'track',
        label: raw,
        detail: index.trackIds.includes(raw) ? undefined : 'not in this session’s list',
        target: { kind: 'track', trackId: raw },
      },
    })
  }

  for (const trackId of index.trackIds) {
    if (ULID.test(raw) && trackId.toLowerCase() === needle) continue // already offered above
    const rank = rankOf(needle, trackId)
    if (rank === null) continue
    ranked.push({
      rank,
      hit: {
        id: `track:${trackId}`,
        kind: 'track',
        label: trackId,
        target: { kind: 'track', trackId },
      },
    })
  }

  for (const entry of index.serials) {
    const serialRank = rankOf(needle, entry.value)
    const labelRank = entry.label ? rankOf(needle, entry.label) : null
    // The better of the two, so typing a label does not lose to the serial it
    // belongs to and produce two rows for one aircraft.
    const useLabel = labelRank !== null && (serialRank === null || labelRank < serialRank)
    const rank = useLabel ? labelRank : serialRank
    if (rank === null) continue
    ranked.push({
      rank,
      hit: {
        id: `serial:${entry.value}`,
        kind: useLabel ? 'label' : 'serial',
        label: useLabel ? (entry.label ?? entry.value) : entry.value,
        detail: useLabel ? entry.value : entry.label,
        // Both go to the serial's flights, never to the label text: a label is
        // a note on an airframe and is not what the flights list filters on.
        target: { kind: 'flights', q: entry.value },
      },
    })
  }

  const macNeedle = normaliseMac(raw)
  for (const entry of index.macs) {
    const rank = rankOf(macNeedle, normaliseMac(entry.value))
    if (rank === null) continue
    ranked.push({
      rank,
      hit: {
        id: `mac:${entry.value}`,
        kind: 'mac',
        label: entry.value,
        detail: entry.vendor,
        target: { kind: 'flights', q: entry.value },
      },
    })
  }

  for (const sensor of index.sensors) {
    const rank = rankOf(needle, sensor.id)
    if (rank === null) continue
    ranked.push({
      rank,
      hit: {
        id: `sensor:${sensor.id}`,
        kind: 'sensor',
        label: sensor.id,
        detail: sensor.kind,
        target: { kind: 'sensor', sensorId: sensor.id },
      },
    })
  }

  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      KIND_ORDER[a.hit.kind] - KIND_ORDER[b.hit.kind] ||
      a.hit.label.localeCompare(b.hit.label),
  )

  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const { hit } of ranked) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    hits.push(hit)
    if (hits.length >= limit) break
  }
  return hits
}

/**
 * Fold the caches the shell already has into the shape `resolveSearch` reads.
 *
 * One pass, deduplicating as it goes: the same aircraft flies repeatedly and
 * every flight carries the same serial and MAC, so without this the list is one
 * row per flight of the same airframe — the thing the command palette's track
 * list had to be sorted by recency to work around.
 */
export function buildSearchIndex(
  tracks: Track[],
  labels: AircraftLabel[],
  sensors: SensorHealth[],
): SearchIndex {
  const serials = new Map<string, { value: string; vendor?: string; label?: string }>()
  const macs = new Map<string, { value: string; vendor?: string }>()
  const trackIds: string[] = []

  const labelBySerial = new Map<string, string>()
  for (const label of labels) {
    if (label.label.length > 0) labelBySerial.set(label.serial, label.label)
  }

  for (const track of tracks) {
    trackIds.push(track.track_id)
    const vendor = track.identity?.vendor ?? undefined
    const serial = track.identity?.serial
    if (serial != null && serial !== '' && !serials.has(serial)) {
      serials.set(serial, {
        value: serial,
        ...(vendor ? { vendor } : {}),
        ...(labelBySerial.has(serial) ? { label: labelBySerial.get(serial) } : {}),
      })
    }
    for (const mac of track.identity?.macs ?? []) {
      if (mac === '' || macs.has(mac)) continue
      macs.set(mac, { value: mac, ...(vendor ? { vendor } : {}) })
    }
  }

  // A labelled aircraft that has not flown this session is still something to
  // search for — the label is the only name an operator remembers.
  for (const [serial, label] of labelBySerial) {
    if (!serials.has(serial)) serials.set(serial, { value: serial, label })
  }

  return {
    trackIds,
    serials: [...serials.values()],
    macs: [...macs.values()],
    sensors: sensors.map((sensor) => ({ id: sensor.sensor_id, kind: sensor.sensor_kind })),
  }
}
