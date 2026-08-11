import { describe, expect, it } from 'vitest'

import type { LogEntry } from '@/features/logs/log-store'
import type { Track } from '@/lib/api/types'

import { buildFeed, countUnread, isCategoryEnabled } from './feed'

const BASE_TRACK: Track = {
  schema_version: '1.0',
  track_id: 't1',
  state: 'CONFIRMED',
  confidence: 0.82,
  first_seen: '2026-08-11T10:00:00Z',
  last_seen: '2026-08-11T10:05:00Z',
  detection_count: 12,
}

const BASE_ENTRY: LogEntry = {
  id: 1,
  at: '2026-08-11T10:01:00Z',
  level: 'info',
  source: 'sensor',
  message: 'wifi-0 healthy',
}

function track(overrides: Partial<Track> = {}): Track {
  return { ...BASE_TRACK, ...overrides }
}

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return { ...BASE_ENTRY, ...overrides }
}

const ALL_ON = {}

function feed(input: Partial<Parameters<typeof buildFeed>[0]> = {}) {
  return buildFeed({
    tracks: [],
    entries: [],
    categories: ALL_ON,
    minLevel: 'info',
    limit: 100,
    ...input,
  })
}

describe('buildFeed', () => {
  it('merges both sources into one list, newest first', () => {
    const result = feed({
      tracks: [track({ track_id: 'a', first_seen: '2026-08-11T10:00:00Z' })],
      entries: [entry({ id: 7, at: '2026-08-11T10:02:00Z' })],
    })

    expect(result.map((n) => n.id)).toEqual(['log:7', 'track:a'])
  })

  it('dates a track from when it first appeared, not when it was last seen', () => {
    // A drone loitering overhead is one thing that happened. Re-dating it to
    // last_seen would pin it to the top of the list and re-mark it unread on
    // every poll.
    const [item] = feed({
      tracks: [
        track({ first_seen: '2026-08-11T09:00:00Z', last_seen: '2026-08-11T11:00:00Z' }),
      ],
    })
    expect(item?.at).toBe('2026-08-11T09:00:00Z')
  })

  it('never lists a drone twice', () => {
    // The session log records track lifecycle too. Admitting those sources
    // would show every drone once from the API and once from the log, with
    // different ids and no way to tell they are the same aircraft.
    const result = feed({
      tracks: [track({ track_id: 'a' })],
      entries: [
        entry({ id: 1, source: 'track', message: 'track a confirmed' }),
        entry({ id: 2, source: 'detection', message: 'detection for a' }),
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('track:a')
  })

  it('drops a category the operator switched off', () => {
    const result = feed({
      tracks: [track()],
      entries: [entry()],
      categories: { drone: false },
    })

    expect(result.map((n) => n.category)).toEqual(['sensor'])
  })

  it('treats an unknown category as on, so a new one needs no migration', () => {
    // Stored preferences written before a category existed have no key for it.
    expect(isCategoryEnabled({}, 'capture')).toBe(true)
    expect(isCategoryEnabled({ capture: false }, 'capture')).toBe(false)
  })

  it('survives preferences from a build that had no notification settings', () => {
    // The regression this exists for: preferences are merged shallowly from
    // localStorage, so a blob written before these keys existed arrives with
    // both undefined. Indexing them unguarded threw during render and took the
    // whole panel down, leaving a header over a blank box.
    const result = buildFeed({
      tracks: [track()],
      entries: [entry()],
      categories: undefined,
      minLevel: undefined,
      limit: 100,
    })

    expect(result.map((n) => n.category)).toEqual(['sensor', 'drone'])
  })

  it('applies the severity floor to system events', () => {
    const result = feed({
      entries: [
        entry({ id: 1, level: 'info', message: 'quiet' }),
        entry({ id: 2, level: 'error', message: 'adapter vanished' }),
      ],
      minLevel: 'warn',
    })

    expect(result.map((n) => n.title)).toEqual(['adapter vanished'])
  })

  it('does not apply the severity floor to drone detections', () => {
    // Tracks are all recorded at info. If the floor applied to them, choosing
    // "errors only" would silently switch off the detections themselves.
    const result = feed({
      tracks: [track()],
      entries: [entry({ level: 'info' })],
      minLevel: 'error',
    })

    expect(result.map((n) => n.category)).toEqual(['drone'])
  })

  it('always carries the confidence of a drone, because a track is evidence not proof', () => {
    const [item] = feed({ tracks: [track({ confidence: 0.41 })] })
    expect(item?.confidence).toBe(0.41)
  })

  it('orders deterministically when two events share a timestamp', () => {
    // Timestamps come from two clocks -- the API's and this browser's -- so
    // exact ties are common. Leaving them to sort stability lets rows swap
    // places between renders.
    const at = '2026-08-11T10:00:00Z'
    const first = feed({
      tracks: [track({ track_id: 'b', first_seen: at })],
      entries: [entry({ at })],
    })
    const second = feed({
      tracks: [track({ track_id: 'b', first_seen: at })],
      entries: [entry({ at })],
    })

    expect(first.map((n) => n.id)).toEqual(second.map((n) => n.id))
  })

  it('caps the list at the render limit', () => {
    const tracks = Array.from({ length: 50 }, (_, i) =>
      track({
        track_id: `t${i}`,
        first_seen: `2026-08-11T10:${String(i).padStart(2, '0')}:00Z`,
      }),
    )
    expect(feed({ tracks, limit: 10 })).toHaveLength(10)
  })

  it('links a track row to its detail page', () => {
    const [item] = feed({ tracks: [track({ track_id: 'abc' })] })
    expect(item?.trackId).toBe('abc')
  })
})

describe('countUnread', () => {
  const watermark = new Date('2026-08-11T10:00:00Z').getTime()

  it('counts only what arrived after the drawer was last opened', () => {
    const result = feed({
      tracks: [
        track({ track_id: 'old', first_seen: '2026-08-11T09:00:00Z' }),
        track({ track_id: 'new', first_seen: '2026-08-11T11:00:00Z' }),
      ],
    })

    expect(countUnread(result, watermark)).toBe(1)
  })

  it('reports nothing unread on a first visit with no history', () => {
    expect(countUnread([], 0)).toBe(0)
  })
})
