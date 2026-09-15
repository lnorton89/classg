/**
 * Time navigation for the flights list: day buckets and window chips.
 *
 * Kibana Discover's shape — a histogram of records over time above the results,
 * each bar a filter. The list had no time navigation at all, so finding last
 * Tuesday's flight meant scrolling a table sorted by the *end* of each flight.
 *
 * Every function here takes `utc` explicitly rather than reading the operator's
 * preference itself. A "day" is a local-calendar concept and this app lets an
 * operator work in UTC; a module that guessed would put a 23:40 local flight in
 * the wrong bar for half the users of the same screen.
 */
import type { Track } from '@/lib/api/types'

import { flightEndMs, flightStartMs } from './flight-metrics'

export const WINDOW_CHIPS = ['today', '24h', '7d', '30d', 'all'] as const
export type WindowChip = (typeof WINDOW_CHIPS)[number]

export const WINDOW_CHIP_LABELS: Record<WindowChip, string> = {
  today: 'Today',
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  all: 'All',
}

const DAY_MS = 86_400_000

function dayParts(ms: number, utc: boolean): { year: number; month: number; day: number } {
  const date = new Date(ms)
  return utc
    ? { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() }
    : { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() }
}

function startOfDayMs(ms: number, utc: boolean, offsetDays = 0): number {
  const { year, month, day } = dayParts(ms, utc)
  return utc
    ? Date.UTC(year, month, day + offsetDays)
    : new Date(year, month, day + offsetDays).getTime()
}

/** `YYYY-MM-DD` in the operator's chosen zone. The URL's `day` parameter. */
export function dayKey(ms: number, utc: boolean): string {
  const { year, month, day } = dayParts(ms, utc)
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The half-open millisecond range a `YYYY-MM-DD` key covers, or null if malformed. */
export function dayRangeMs(
  key: string,
  utc: boolean,
): { startMs: number; endMs: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const startMs = utc ? Date.UTC(year, month, day) : new Date(year, month, day).getTime()
  if (!Number.isFinite(startMs)) return null
  // Built from the calendar rather than by adding 86_400_000, so the bar for a
  // DST changeover covers the 23- or 25-hour day people actually lived through.
  const endMs = utc ? Date.UTC(year, month, day + 1) : new Date(year, month, day + 1).getTime()
  return { startMs, endMs }
}

/**
 * The `since` an API query should carry for a window chip, or undefined for
 * "All" — the API treats an absent `since` as unbounded.
 */
export function windowSince(chip: WindowChip, now: number, utc: boolean): string | undefined {
  switch (chip) {
    case 'today':
      return new Date(startOfDayMs(now, utc)).toISOString()
    case '24h':
      return new Date(now - DAY_MS).toISOString()
    case '7d':
      return new Date(now - 7 * DAY_MS).toISOString()
    case '30d':
      return new Date(now - 30 * DAY_MS).toISOString()
    case 'all':
      return undefined
  }
}

/**
 * The span of wall time the list is currently looking at.
 *
 * A filter only has to answer "is this row in or out"; a band of time has to
 * know where its own edges are, and the lanes view draws one over exactly the
 * flights the table is showing. Precedence follows what the operator narrowed
 * to last: a picked day beats a window chip, because clicking a histogram bar
 * inside "30 d" means that day and not thirty.
 *
 * "All" has no edges of its own, so it takes them from the flights that are
 * loaded — which is honest about what it is: not all of history, but everything
 * this page has. With nothing loaded it falls back to the last day rather than
 * a zero-width band, which would divide by zero in every scale on the axis.
 */
export function flightWindowMs(
  tracks: Track[],
  chip: WindowChip,
  day: string | undefined,
  nowMs: number,
  utc: boolean,
): { startMs: number; endMs: number } {
  if (day !== undefined) {
    const range = dayRangeMs(day, utc)
    if (range) return range
  }

  const since = windowSince(chip, nowMs, utc)
  if (since !== undefined) {
    const startMs = Date.parse(since)
    if (Number.isFinite(startMs) && startMs < nowMs) return { startMs, endMs: nowMs }
  }

  let startMs = Infinity
  let endMs = -Infinity
  for (const track of tracks) {
    const first = flightStartMs(track)
    const last = flightEndMs(track)
    if (first !== null) startMs = Math.min(startMs, first)
    if (last !== null) endMs = Math.max(endMs, last)
  }
  if (startMs === Infinity || endMs === -Infinity || endMs <= startMs) {
    return { startMs: nowMs - DAY_MS, endMs: nowMs }
  }
  // Nudged past the newest flight rather than ending on it: `packLanes` keeps
  // an event only while it starts strictly before the window's end, so a band
  // built around one instantaneous flight would not contain it.
  const pad = Math.min(DAY_MS, Math.max(60_000, (endMs - startMs) / 20))
  return { startMs, endMs: endMs + pad }
}

/**
 * "Sep 15" for an axis label.
 *
 * Built here rather than taken from `useFormat().timestamp` because that one
 * always carries a time, and splitting the date back out of a localised
 * timestamp string is a guess about where the locale put its commas.
 */
export function dayLabel(ms: number, utc: boolean): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(utc ? { timeZone: 'UTC' } : {}),
  }).format(new Date(ms))
}

export interface DayBucket {
  /** `YYYY-MM-DD`. */
  key: string
  startMs: number
  count: number
}

/**
 * Above this the contiguous fill is dropped and only days with flights are
 * returned. A year of retention is 365 bars in a strip a few hundred pixels
 * wide, which is a texture rather than a chart; a sparse axis that says so is
 * more honest than 300 invisible zero-bars.
 */
const MAX_CONTIGUOUS_DAYS = 120

export interface DayHistogram {
  buckets: DayBucket[]
  /** False when empty days were dropped, so the axis can say the gaps are not to scale. */
  contiguous: boolean
}

/**
 * One bucket per day between the first and last flight loaded.
 *
 * Empty days are included: a gap in the histogram is information — it is the
 * difference between "nothing flew on Tuesday" and "Tuesday is off the end of
 * what has been loaded" — and a bar chart that silently omits its zeros makes
 * the two look identical.
 *
 * Bucketed on `first_seen`. A flight belongs to the day it started, which is
 * how a person remembers it; the alternative, splitting a flight across the
 * midnight it crossed, would count one flight twice.
 */
export function bucketFlightsByDay(tracks: Track[], utc: boolean): DayHistogram {
  const counts = new Map<string, { startMs: number; count: number }>()
  for (const track of tracks) {
    const startMs = flightStartMs(track)
    if (startMs === null) continue
    const key = dayKey(startMs, utc)
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else counts.set(key, { startMs: startOfDayMs(startMs, utc), count: 1 })
  }
  if (counts.size === 0) return { buckets: [], contiguous: true }

  const present = [...counts.entries()]
    .map(([key, value]) => ({ key, startMs: value.startMs, count: value.count }))
    .sort((a, b) => a.startMs - b.startMs)

  const first = present[0]
  const last = present[present.length - 1]
  if (!first || !last) return { buckets: [], contiguous: true }

  const spanDays = Math.round((last.startMs - first.startMs) / DAY_MS) + 1
  if (spanDays > MAX_CONTIGUOUS_DAYS) return { buckets: present, contiguous: false }

  const buckets: DayBucket[] = []
  for (let cursor = first.startMs; cursor <= last.startMs;) {
    const key = dayKey(cursor, utc)
    buckets.push({ key, startMs: cursor, count: counts.get(key)?.count ?? 0 })
    cursor = startOfDayMs(cursor, utc, 1)
  }
  return { buckets, contiguous: true }
}
