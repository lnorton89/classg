import { describe, expect, it } from 'vitest'

import { MIN_EVENT_MS, fractionAt, laneCount, packLanes, ticks, timeAt } from './lanes'
import type { Track } from '@/lib/api/types'

const T0 = Date.parse('2026-08-11T12:00:00.000Z')
const HOUR = 3_600_000

function track(id: string, fromMs: number, toMs: number): Track {
  return {
    schema_version: '1.0',
    track_id: id,
    state: 'CONFIRMED',
    first_seen: new Date(fromMs).toISOString(),
    last_seen: new Date(toMs).toISOString(),
    detection_count: 1,
    identity: {},
    confidence: 0.8,
    adsb_correlated: false,
  }
}

const window = { startMs: T0, endMs: T0 + 6 * HOUR }

describe('packLanes', () => {
  it('puts non-overlapping tracks in one lane', () => {
    const events = packLanes(
      [track('a', T0, T0 + HOUR), track('b', T0 + 2 * HOUR, T0 + 3 * HOUR)],
      window,
    )
    expect(events.map((e) => e.lane)).toEqual([0, 0])
    expect(laneCount(events)).toBe(1)
  })

  it('uses one lane per simultaneous track, and no more', () => {
    const events = packLanes(
      [
        track('a', T0, T0 + 3 * HOUR),
        track('b', T0 + HOUR, T0 + 2 * HOUR),
        track('c', T0 + HOUR, T0 + 2 * HOUR),
        // After the first three are done, so it reuses lane 0.
        track('d', T0 + 4 * HOUR, T0 + 5 * HOUR),
      ],
      window,
    )
    expect(laneCount(events)).toBe(3)
    expect(events.find((e) => e.track.track_id === 'd')?.lane).toBe(0)
  })

  // Two bars that merely touch render as one, which reads as a single aircraft
  // present the whole time rather than two arriving in sequence.
  it('keeps a gap between neighbours in a lane', () => {
    const events = packLanes(
      [track('a', T0, T0 + HOUR), track('b', T0 + HOUR, T0 + 2 * HOUR)],
      window,
    )
    expect(events.map((e) => e.lane)).toEqual([0, 1])
  })

  it('clamps to the window and says it clipped', () => {
    const events = packLanes([track('a', T0 - 5 * HOUR, T0 + 20 * HOUR)], window)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      fromMs: window.startMs,
      toMs: window.endMs,
      clippedStart: true,
      clippedEnd: true,
    })
  })

  it('drops tracks outside the window entirely', () => {
    const events = packLanes(
      [
        track('old', T0 - 10 * HOUR, T0 - 9 * HOUR),
        track('future', T0 + 9 * HOUR, T0 + 10 * HOUR),
      ],
      window,
    )
    expect(events).toEqual([])
  })

  // A drone heard once is the case this whole system exists for. A zero-width
  // bar would be invisible.
  it('gives an instantaneous track a visible width', () => {
    const events = packLanes([track('blip', T0 + HOUR, T0 + HOUR)], window)
    expect(events).toHaveLength(1)
    expect(events.map((e) => e.toMs - e.fromMs)).toEqual([MIN_EVENT_MS])
  })

  // A bad timestamp clamped to the epoch would draw a bar across everything.
  it('drops a track with an unparseable timestamp rather than drawing it', () => {
    const bad: Track = { ...track('bad', T0, T0 + HOUR), first_seen: 'not a date' }
    expect(packLanes([bad], window)).toEqual([])
  })
})

describe('ticks', () => {
  it('lands on wall-clock boundaries', () => {
    for (const t of ticks(window)) {
      expect(new Date(t).getUTCMinutes()).toBe(0)
    }
  })

  it('scales the interval to the window', () => {
    const day = { startMs: T0, endMs: T0 + 24 * HOUR }
    const hourWindow = { startMs: T0, endMs: T0 + HOUR }
    expect(ticks(day).length).toBeLessThanOrEqual(6)
    expect(ticks(hourWindow).length).toBeLessThanOrEqual(6)
    expect(ticks(hourWindow).length).toBeGreaterThan(0)
  })

  it('returns nothing for an empty window rather than looping', () => {
    expect(ticks({ startMs: T0, endMs: T0 })).toEqual([])
  })
})

describe('fractionAt and timeAt', () => {
  it('round-trip', () => {
    const mid = T0 + 3 * HOUR
    expect(fractionAt(window, mid)).toBeCloseTo(0.5)
    expect(timeAt(window, 0.5)).toBeCloseTo(mid)
  })

  it('clamps outside the window', () => {
    expect(fractionAt(window, T0 - HOUR)).toBe(0)
    expect(fractionAt(window, T0 + 100 * HOUR)).toBe(1)
  })
})
