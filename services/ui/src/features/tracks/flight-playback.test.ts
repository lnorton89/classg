/**
 * The scrubber's arithmetic. The case worth pinning is the reception gap: a
 * marker that slides smoothly across seven minutes of silence is the most
 * confident-looking thing on the page and the least supported by evidence.
 */
import { describe, expect, it } from 'vitest'

import type { Position } from '@/lib/api/types'

import { frameAt, playbackSpan } from './flight-playback'

const T0 = Date.parse('2026-09-14T23:16:58.000Z')

function at(
  seconds: number,
  lat: number,
  lon: number,
  extra: Partial<Position> = {},
): Position {
  return { lat, lon, at: new Date(T0 + seconds * 1000).toISOString(), ...extra }
}

describe('playbackSpan', () => {
  it('covers the first and last dated fix', () => {
    expect(playbackSpan([at(0, 51, -1), at(30, 51, -1)])).toEqual({
      startMs: T0,
      endMs: T0 + 30_000,
    })
  })

  it('is null when nothing is dated', () => {
    expect(playbackSpan([{ lat: 51, lon: -1 }])).toBeNull()
  })

  it('is a zero-length span for a single fix rather than null', () => {
    // The scrubber renders disabled, which says "nothing to replay"; absent it
    // would silently drop a control the page otherwise has.
    expect(playbackSpan([at(4, 51, -1)])).toEqual({ startMs: T0 + 4000, endMs: T0 + 4000 })
  })
})

describe('frameAt', () => {
  const path = [at(0, 51, -1), at(10, 51, -0.9), at(20, 51.1, -0.9)]

  it('interpolates halfway between two fixes', () => {
    const frame = frameAt(path, T0 + 5000)
    expect(frame?.lat).toBeCloseTo(51, 6)
    expect(frame?.lon).toBeCloseTo(-0.95, 6)
    expect(frame?.heard).toBe(true)
  })

  it('lands exactly on a fix', () => {
    const frame = frameAt(path, T0 + 10_000)
    expect(frame?.lat).toBeCloseTo(51, 6)
    expect(frame?.lon).toBeCloseTo(-0.9, 6)
  })

  it('clamps before the start and after the end', () => {
    expect(frameAt(path, T0 - 60_000)?.lon).toBeCloseTo(-1, 6)
    expect(frameAt(path, T0 + 600_000)?.lat).toBeCloseTo(51.1, 6)
  })

  it('holds the last heard fix through a reception gap', () => {
    const gapped = [at(0, 51, -1), at(600, 52, -2)]
    const frame = frameAt(gapped, T0 + 300_000)
    // Not the midpoint 51.5/-1.5: nothing knows where the aircraft was.
    expect(frame?.lat).toBeCloseTo(51, 6)
    expect(frame?.lon).toBeCloseTo(-1, 6)
    expect(frame?.heard).toBe(false)
  })

  it('interpolates height and speed only where both ends reported them', () => {
    const measured = [
      at(0, 51, -1, { height_agl_m: 0, speed_mps: 0 }),
      at(10, 51, -1, { height_agl_m: 100, speed_mps: 10 }),
    ]
    const frame = frameAt(measured, T0 + 5000)
    expect(frame?.heightAglM).toBeCloseTo(50, 6)
    expect(frame?.speedMps).toBeCloseTo(5, 6)
  })

  it('holds a reading rather than dropping it when only one end carried it', () => {
    const partial = [at(0, 51, -1, { height_agl_m: 40 }), at(10, 51, -1)]
    expect(frameAt(partial, T0 + 5000)?.heightAglM).toBe(40)
  })

  it('takes a heading the short way round the compass', () => {
    const turning = [at(0, 51, -1, { track_deg: 350 }), at(10, 51, -1, { track_deg: 10 })]
    // 0, not 180: the aircraft crossed north rather than swinging all the way
    // back through south.
    expect(frameAt(turning, T0 + 5000)?.trackDeg).toBeCloseTo(0, 6)
  })

  it('ignores undated points instead of placing them on the axis', () => {
    const mixed: Position[] = [at(0, 51, -1), { lat: 0, lon: 0 }, at(10, 51, -0.9)]
    const frame = frameAt(mixed, T0 + 5000)
    expect(frame?.lat).toBeCloseTo(51, 6)
    expect(frame?.lon).toBeCloseTo(-0.95, 6)
  })

  it('is null for a path with no dated points at all', () => {
    expect(frameAt([{ lat: 51, lon: -1 }], T0)).toBeNull()
  })
})
