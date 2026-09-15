/**
 * The sensor's map-valued counters, as rankings rather than as comma lists.
 *
 * `dwell_share`, `beacons_per_channel` and `drone_hits_per_channel` are the
 * three readings on this page that are actually distributions: they answer
 * "where does this radio spend its time, and was that where the drones were".
 * Rendered through the generic detail formatter they came out as
 * `6: 57.6%, 1: 28.1%, 11: 14.3%, +3 more` — every fact present, the shape the
 * question is about reconstructed by the reader, and half the channels elided
 * to keep the row from wrapping.
 *
 * Splitting them out is also what makes the "+3 more" truncation unnecessary:
 * a stack of short bars costs a line each and no horizontal space at all.
 */
import type { KeyValueEntry } from '@/components/ui/key-value-group'

export interface Breakdown {
  key: string
  title: string
  description: string
  entries: KeyValueEntry[]
}

interface Known {
  title: string
  description: string
  /** Values are 0–1 shares rather than counts, so they render as percentages. */
  share?: boolean
  /** Tailwind fill class. Drone hits get the track hue; airtime does not. */
  bar?: string
}

/**
 * Declaration order is display order: where the radio was, then what everyone
 * else was doing there, then what we were looking for.
 */
const KNOWN: Record<string, Known> = {
  dwell_share: {
    title: 'Dwell share by channel',
    description: 'Where the receiver spent its listening time.',
    share: true,
    bar: 'bg-primary',
  },
  beacons_per_channel: {
    title: 'Beacons by channel',
    description: 'Ambient Wi-Fi. Mostly other people, and not a detection.',
    bar: 'bg-muted-foreground',
  },
  drone_hits_per_channel: {
    title: 'Drone hits by channel',
    description: 'Where the detections actually were.',
    bar: 'bg-track',
  },
}

export const BREAKDOWN_KEYS = Object.keys(KNOWN)

/**
 * Channel keys sort numerically, not lexically. `11` before `2` is the sort a
 * string comparison gives, and on a Wi-Fi channel list that reads as data
 * corruption rather than as a sort order.
 */
function byChannel(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b)
}

function entriesOf(value: unknown, known: Known): KeyValueEntry[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const numeric = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  )
  if (numeric.length === 0) return []

  return numeric
    .sort(([a], [b]) => byChannel(a, b))
    .map(([channel, count]) => ({
      id: channel,
      label: `ch ${channel}`,
      value: known.share ? `${(count * 100).toFixed(1)}%` : count.toLocaleString(),
      // Negative counters are not a thing a radio reports, but a bar sized from
      // one would render outside its track; clamping here keeps that impossible
      // rather than merely unlikely.
      fraction: Math.max(0, count),
      barClassName: known.bar,
    }))
}

/**
 * Every distribution this sensor reported, in display order. A key the sensor
 * does not send, or sends empty, produces no group at all — an empty "Dwell
 * share" heading would claim the radio hopped nowhere.
 */
export function sensorBreakdowns(detail: Record<string, unknown>): Breakdown[] {
  const out: Breakdown[] = []
  for (const key of BREAKDOWN_KEYS) {
    const known = KNOWN[key]
    if (known === undefined || !(key in detail)) continue
    const entries = entriesOf(detail[key], known)
    if (entries.length === 0) continue
    out.push({ key, title: known.title, description: known.description, entries })
  }
  return out
}
