/**
 * The notification feed: one ordered list from two very different sources.
 *
 * Drone activity comes from the API's track list. Everything else — sensor
 * health, stream drops, captures, API failures, operator actions — comes from
 * the in-memory session log. They are merged here rather than in the drawer so
 * the ordering and dedup rules are testable without rendering anything.
 *
 * Why both, rather than just the session log: the log starts empty on every
 * page load. A drawer built only on it would show nothing after a refresh even
 * though drones flew an hour ago, which is precisely the question the drawer
 * exists to answer. The API side survives reloads; the log side is the only
 * record of the things the API never stored.
 *
 * Drones come from the API *only*. The session log also records track
 * lifecycle under the `track` and `detection` sources, so admitting those would
 * list every drone twice — once from each side, with different ids and no way
 * to tell they are the same aircraft. The API is the authority for what flew;
 * the log is the authority for what the console did.
 */
import type { LogEntry, LogLevel, LogSource } from '@/features/logs/log-store'
import { LEVEL_RANK } from '@/features/logs/log-store'
import { formatHeadline } from '@/features/tracks/share/share-card-model'
import type { Track } from '@/lib/api/types'

export type NotifyCategory =
  'drone' | 'sensor' | 'stream' | 'capture' | 'spectrum' | 'unit' | 'api' | 'action'

export const NOTIFY_CATEGORIES: NotifyCategory[] = [
  'drone',
  'sensor',
  'stream',
  'capture',
  'spectrum',
  'unit',
  'api',
  'action',
]

export const NOTIFY_CATEGORY_LABEL: Record<NotifyCategory, string> = {
  drone: 'Drone detections',
  sensor: 'Sensor health',
  stream: 'Connection',
  capture: 'Captures',
  spectrum: 'Band sweeps',
  unit: 'Unit maintenance',
  api: 'API errors',
  action: 'Operator actions',
}

export const NOTIFY_CATEGORY_HINT: Record<NotifyCategory, string> = {
  drone: 'A track appearing in range. The reason this box is switched on.',
  sensor: 'An adapter going unhealthy, recovering, or vanishing from USB.',
  stream: 'The live stream connecting, dropping, or falling back to polling.',
  capture: 'PCAP and IQ capture activity.',
  spectrum: 'A sweep starting or landing. One takes the radio from ADS-B while it runs.',
  unit: 'What the unit did to itself: deploys it pulled, repairs the watchdog made.',
  api: 'Requests this console made that the API refused or never answered.',
  action: 'What was clicked in this browser. Useful when two people share a console.',
}

/**
 * Session-log sources that map onto a notification category. `track` and
 * `detection` are deliberately absent — see the module note above.
 */
const SOURCE_CATEGORY: Partial<Record<LogSource, NotifyCategory>> = {
  sensor: 'sensor',
  stream: 'stream',
  capture: 'capture',
  spectrum: 'spectrum',
  deploy: 'unit',
  api: 'api',
  ui: 'action',
}

export interface Notification {
  /** Stable across rebuilds of the feed, so React keys and the read watermark hold. */
  id: string
  /** ISO 8601. The merge key and the sort key. */
  at: string
  category: NotifyCategory
  level: LogLevel
  title: string
  /** Plain descriptors that need no unit or locale formatting. */
  meta: string[]
  /** Formatted by the row, which owns the operator's display preferences. */
  confidence?: number
  /** When present, the row links to that track. */
  trackId?: string
}

/**
 * Both preference-derived fields are optional.
 *
 * Not defensive habit — a stored preferences blob written by an earlier build
 * has neither key, and `readStored()` merges shallowly, so the value really can
 * arrive undefined. Indexing it unguarded threw and took the whole panel down
 * with it, leaving a header over a blank box.
 */
export interface FeedInput {
  tracks: Track[]
  entries: LogEntry[]
  /** Categories the operator has switched on. A missing key counts as on. */
  categories: Partial<Record<NotifyCategory, boolean>> | undefined
  /** Minimum severity for session events. Does not apply to drone detections. */
  minLevel: LogLevel | undefined
  limit: number
}

export function isCategoryEnabled(
  categories: Partial<Record<NotifyCategory, boolean>> | undefined,
  category: NotifyCategory,
): boolean {
  // Absent means on: a build that adds a category must not leave it silently
  // filtered out for everyone with a stored preferences blob from before it
  // existed. Only an explicit `false` switches one off.
  return categories?.[category] !== false
}

/**
 * A track becomes a notification at the moment it first appeared, not the
 * moment it was last seen. A drone that loiters for an hour is one thing that
 * happened, and re-dating it to `last_seen` would keep it pinned to the top of
 * the list and re-mark it unread on every poll.
 */
function trackNotification(track: Track): Notification {
  const meta = [track.identity?.vendor ?? 'unknown vendor', stateLabel(track.state)]
  if (track.detection_count > 0) {
    meta.push(`${track.detection_count} detection${track.detection_count === 1 ? '' : 's'}`)
  }

  return {
    id: `track:${track.track_id}`,
    at: track.first_seen,
    category: 'drone',
    // Never above info. A drone overhead is the expected case for a drone
    // detector; painting it as a warning would leave nothing to say when a
    // sensor actually fails.
    level: 'info',
    title: trackTitle(track),
    meta,
    confidence: track.confidence,
    trackId: track.track_id,
  }
}

/**
 * What to call the aircraft, in one register.
 *
 * The old rule was "the raw serial, or 'Unidentified drone'" -- which titled
 * one drone `1581F9DEC259E8296040` and its neighbour "Unidentified drone",
 * two different kinds of name for the same kind of event. The share card
 * already solved naming (formatHeadline: "DJI Multirotor"), so this reuses it
 * and keeps just enough serial to tell two DJIs apart.
 */
function trackTitle(track: Track): string {
  const serial = track.identity?.serial
  const label = formatHeadline(track.identity?.vendor ?? '', track.identity?.ua_type ?? '')
  // A 20-character Remote ID serial is abbreviated to its tail; a short one is
  // its own best name and an ellipsis would only mangle it.
  const tail = serial ? (serial.length > 8 ? `…${serial.slice(-6)}` : serial) : null
  if (label === 'Unidentified aircraft') {
    return tail ? `Drone ${tail}` : 'Unidentified drone'
  }
  return tail ? `${label} ${tail}` : label
}

function stateLabel(state: Track['state']): string {
  return state === 'CONFIRMED' ? 'in flight' : state.toLowerCase()
}

function entryNotification(entry: LogEntry, category: NotifyCategory): Notification {
  const meta: string[] = []
  for (const [key, value] of Object.entries(entry.detail ?? {})) {
    if (value === null || value === undefined) continue
    meta.push(`${key} ${String(value)}`)
  }

  return {
    id: `log:${entry.id}`,
    at: entry.at,
    category,
    level: entry.level,
    title: entry.message,
    meta,
    ...(entry.trackId ? { trackId: entry.trackId } : {}),
  }
}

export function buildFeed({
  tracks,
  entries,
  categories,
  minLevel,
  limit,
}: FeedInput): Notification[] {
  const merged: Notification[] = []

  if (isCategoryEnabled(categories, 'drone')) {
    for (const track of tracks) merged.push(trackNotification(track))
  }

  const floor = LEVEL_RANK[minLevel ?? 'info']
  for (const entry of entries) {
    const category = SOURCE_CATEGORY[entry.source]
    if (!category) continue
    if (!isCategoryEnabled(categories, category)) continue
    // The severity floor is a session-event control only. Drone detections are
    // all `info`, so applying it to them would let "warnings and above" quietly
    // switch off the detections themselves.
    if (LEVEL_RANK[entry.level] < floor) continue
    merged.push(entryNotification(entry, category))
  }

  merged.sort(byNewestFirst)
  return merged.slice(0, limit)
}

/**
 * Newest first, with the id as a tiebreak. Timestamps here come from two
 * clocks — the API's and this browser's — so exact ties are common enough that
 * leaving the order to the sort's stability would let rows swap places between
 * renders.
 */
function byNewestFirst(a: Notification, b: Notification): number {
  const delta = new Date(b.at).getTime() - new Date(a.at).getTime()
  return delta !== 0 ? delta : a.id.localeCompare(b.id)
}

/**
 * How many entries arrived after the operator last opened the drawer.
 *
 * Counts what the badge is FOR: drone activity, and session events that are
 * actually wrong (warning and up). Info-level housekeeping -- "console session
 * started", "live stream connected" -- is generated by the act of opening the
 * app, so counting it meant the bell showed new-item counts on every single
 * visit and the one notification that matters arrived pre-drowned. Those rows
 * still appear in the drawer; they just don't claim to be news.
 */
export function countUnread(feed: Notification[], lastSeenAt: number): number {
  return feed.filter(
    (item) =>
      new Date(item.at).getTime() > lastSeenAt &&
      (item.category === 'drone' || LEVEL_RANK[item.level] > LEVEL_RANK.info),
  ).length
}
