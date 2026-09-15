import { describe, expect, it } from 'vitest'

import type { Track } from '@/lib/api/types'

import {
  bucketFlightsByDay,
  dayKey,
  dayRangeMs,
  flightWindowMs,
  windowSince,
} from './flight-time'

function flight(trackId: string, firstSeen: string): Track {
  return {
    schema_version: '1.0',
    track_id: trackId,
    state: 'CLOSED',
    first_seen: firstSeen,
    last_seen: firstSeen,
    detection_count: 1,
    confidence: 0.6,
  }
}

describe('dayKey', () => {
  it('formats as YYYY-MM-DD, zero-padded', () => {
    expect(dayKey(Date.UTC(2026, 8, 5, 12), true)).toBe('2026-09-05')
    expect(dayKey(Date.UTC(2026, 0, 1), true)).toBe('2026-01-01')
  })

  it('reads the same instant as a different day in UTC and in local time', () => {
    // Only meaningful off UTC, which is where the bug would be: a 23:40 local
    // flight belongs in the local bar an operator is looking at.
    const ms = Date.UTC(2026, 8, 15, 23, 40)
    const local = new Date(ms)
    expect(dayKey(ms, false)).toBe(
      `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`,
    )
  })
})

describe('dayRangeMs', () => {
  it('is half-open: midnight inclusive, next midnight exclusive', () => {
    const range = dayRangeMs('2026-09-15', true)
    expect(range).toEqual({
      startMs: Date.UTC(2026, 8, 15),
      endMs: Date.UTC(2026, 8, 16),
    })
  })

  it('rejects anything that is not a day key', () => {
    expect(dayRangeMs('yesterday', true)).toBeNull()
    expect(dayRangeMs('2026-9-15', true)).toBeNull()
  })

  it('round-trips with dayKey', () => {
    const ms = Date.UTC(2026, 8, 15, 17, 3)
    const range = dayRangeMs(dayKey(ms, true), true)
    expect(range?.startMs).toBeLessThanOrEqual(ms)
    expect(range?.endMs).toBeGreaterThan(ms)
  })
})

describe('windowSince', () => {
  const now = Date.UTC(2026, 8, 15, 14, 30)

  it('is undefined for All, which is what the API reads as unbounded', () => {
    expect(windowSince('all', now, true)).toBeUndefined()
  })

  it('counts back from now for the rolling windows', () => {
    expect(windowSince('24h', now, true)).toBe(new Date(now - 86_400_000).toISOString())
    expect(windowSince('7d', now, true)).toBe(new Date(now - 7 * 86_400_000).toISOString())
    expect(windowSince('30d', now, true)).toBe(new Date(now - 30 * 86_400_000).toISOString())
  })

  it('snaps Today to midnight rather than 24 hours back', () => {
    expect(windowSince('today', now, true)).toBe(new Date(Date.UTC(2026, 8, 15)).toISOString())
  })
})

describe('bucketFlightsByDay', () => {
  it('counts flights against the day they STARTED', () => {
    const { buckets } = bucketFlightsByDay(
      [
        flight('a', '2026-09-15T09:00:00Z'),
        flight('b', '2026-09-15T21:00:00Z'),
        flight('c', '2026-09-13T09:00:00Z'),
      ],
      true,
    )
    expect(buckets.map((b) => [b.key, b.count])).toEqual([
      ['2026-09-13', 1],
      ['2026-09-14', 0],
      ['2026-09-15', 2],
    ])
  })

  it('includes the empty days between, because a gap is information', () => {
    const { buckets, contiguous } = bucketFlightsByDay(
      [flight('a', '2026-09-10T09:00:00Z'), flight('b', '2026-09-15T09:00:00Z')],
      true,
    )
    expect(contiguous).toBe(true)
    expect(buckets).toHaveLength(6)
    expect(buckets.filter((b) => b.count === 0)).toHaveLength(4)
  })

  it('drops the contiguous fill past the cap and says so', () => {
    const { buckets, contiguous } = bucketFlightsByDay(
      [flight('a', '2025-01-01T09:00:00Z'), flight('b', '2026-09-15T09:00:00Z')],
      true,
    )
    expect(contiguous).toBe(false)
    expect(buckets).toHaveLength(2)
  })

  it('is empty, and contiguous, for no flights', () => {
    expect(bucketFlightsByDay([], true)).toEqual({ buckets: [], contiguous: true })
  })

  it('skips a track whose first_seen cannot be parsed instead of bucketing NaN', () => {
    const { buckets } = bucketFlightsByDay(
      [flight('bad', 'not a time'), flight('good', '2026-09-15T09:00:00Z')],
      true,
    )
    expect(buckets).toEqual([{ key: '2026-09-15', startMs: Date.UTC(2026, 8, 15), count: 1 }])
  })
})

/**
 * The lanes view draws a band over the flights the list is showing, so its
 * edges have to be the list's own narrowing rather than a second window kept
 * beside it. That divergence is exactly what the Timeline page had: picking a
 * day here and opening it there landed on "the last 24 hours".
 */
describe('flightWindowMs', () => {
  const NOW = Date.UTC(2026, 8, 15, 12)

  it('takes a picked day over the window chip it was picked inside', () => {
    expect(flightWindowMs([], '30d', '2026-09-10', NOW, true)).toEqual({
      startMs: Date.UTC(2026, 8, 10),
      endMs: Date.UTC(2026, 8, 11),
    })
  })

  it('runs from the chip’s own since to now', () => {
    expect(flightWindowMs([], '24h', undefined, NOW, true)).toEqual({
      startMs: NOW - 86_400_000,
      endMs: NOW,
    })
  })

  it('falls back to the chip when the day in the URL is malformed', () => {
    // validateSearch already rejects these, so this is the belt to that
    // braces: a window is not a control that may fail to render.
    expect(flightWindowMs([], '24h', '15/09/2026', NOW, true).startMs).toBe(NOW - 86_400_000)
  })

  it('fits itself to the loaded flights when the chip is All', () => {
    // Not named `window`: that binding shadows the global one for the rest of
    // the scope, which is the trap `routes/timeline.tsx` already records.
    const band = flightWindowMs(
      [flight('a', '2026-09-01T09:00:00Z'), flight('b', '2026-09-14T10:00:00Z')],
      'all',
      undefined,
      NOW,
      true,
    )
    expect(band.startMs).toBe(Date.parse('2026-09-01T09:00:00Z'))
    // Past the newest flight rather than on it: packLanes keeps an event only
    // while it starts strictly before the window's end.
    expect(band.endMs).toBeGreaterThan(Date.parse('2026-09-14T10:00:00Z'))
  })

  it('never returns a zero-width band, which every scale on the axis divides by', () => {
    const band = flightWindowMs([], 'all', undefined, NOW, true)
    expect(band.endMs - band.startMs).toBeGreaterThan(0)
    expect(band.endMs).toBe(NOW)
  })
})
