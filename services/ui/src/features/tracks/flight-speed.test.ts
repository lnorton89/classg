/**
 * The two ways this could quietly lie: inventing a speed the aircraft never
 * reported, and calling a reception gap a hover because the speed either side
 * of it was low. Both produce a map that looks more informative than the data.
 */
import { describe, expect, it } from 'vitest'

import type { Position } from '@/lib/api/types'

import {
  DWELL_MAX_SPEED_MPS,
  dwellPoints,
  pathSegments,
  pointSpeeds,
  speedExtent,
  timeExtent,
} from './flight-speed'

const T0 = Date.parse('2026-09-14T23:16:58.000Z')

function at(seconds: number, speed?: number | null, lat = 51.5, lon = -0.1): Position {
  return {
    lat,
    lon,
    speed_mps: speed ?? null,
    at: new Date(T0 + seconds * 1000).toISOString(),
  }
}

describe('pointSpeeds', () => {
  it('keeps reported speeds untouched', () => {
    expect(pointSpeeds([at(0, 2), at(1, 8)])).toEqual([2, 8])
  })

  it('interpolates a run of unreported speeds between two known ones', () => {
    // 0 s at 0 m/s, 4 s at 8 m/s, evenly spaced points in between.
    const speeds = pointSpeeds([at(0, 0), at(1), at(2), at(3), at(4, 8)])
    expect(speeds).toEqual([0, 2, 4, 6, 8])
  })

  it('interpolates in time, not in point index', () => {
    // The middle sample sits at 3 of the 4 seconds, so it is three quarters of
    // the way up the ramp -- not half, which is where index weighting puts it.
    const speeds = pointSpeeds([at(0, 0), at(3), at(4, 8)])
    expect(speeds[1]).toBeCloseTo(6, 6)
  })

  it('never extrapolates past the last reported speed', () => {
    // Filling these in would invent a measurement at exactly the moment the
    // aircraft stopped providing one.
    expect(pointSpeeds([at(0), at(1, 4), at(2)])).toEqual([null, 4, null])
  })

  it('refuses to interpolate across a reception gap', () => {
    // 0 s at 1 m/s, then silence until 120 s. Nothing knows what happened in
    // between, so nothing is drawn as if it did.
    const speeds = pointSpeeds([at(0, 1), at(60), at(120, 9)])
    expect(speeds).toEqual([1, null, 9])
  })
})

describe('pathSegments', () => {
  it('averages the two ends of a segment', () => {
    const [segment] = pathSegments([at(0, 2), at(1, 6)])
    expect(segment?.speedMps).toBe(4)
  })

  it('falls back to whichever end reported a speed', () => {
    const [segment] = pathSegments([at(0, 5), at(1)])
    // at(1) is past the last reported speed, so it has none -- and a segment
    // with one known end is still a measurement of something.
    expect(segment?.speedMps).toBe(5)
  })

  it('marks a reception gap and gives it no speed at all', () => {
    const segments = pathSegments([at(0, 3), at(120, 3)])
    expect(segments[0]?.gap).toBe(true)
    expect(segments[0]?.speedMps).toBeNull()
  })

  it('produces one fewer segment than points, and none for a single fix', () => {
    expect(pathSegments([at(0, 1), at(1, 1), at(2, 1)])).toHaveLength(2)
    expect(pathSegments([at(0, 1)])).toHaveLength(0)
  })
})

describe('speedExtent', () => {
  it('spans only the segments that carry a measurement', () => {
    const segments = pathSegments([at(0, 1), at(1, 9), at(2, 5)])
    expect(speedExtent(segments)).toEqual({ min: 5, max: 7 })
  })

  it('is null when nothing reported a speed', () => {
    expect(speedExtent(pathSegments([at(0), at(1)]))).toBeNull()
  })

  it('is a zero-width extent for a constant speed, not null', () => {
    // The caller needs to tell "6 m/s throughout" from "no speed reported".
    expect(speedExtent(pathSegments([at(0, 6), at(1, 6)]))).toEqual({ min: 6, max: 6 })
  })
})

describe('timeExtent', () => {
  it('covers the dated points and ignores the undated ones', () => {
    const undated: Position = { lat: 51.5, lon: -0.1 }
    expect(timeExtent([at(0, 1), undated, at(10, 1)])).toEqual({
      min: T0,
      max: T0 + 10_000,
    })
  })
})

describe('dwellPoints', () => {
  function hover(seconds: number, speed = 0.2): Position[] {
    const points: Position[] = []
    for (let s = 0; s <= seconds; s += 1) points.push(at(s, speed))
    return points
  }

  it('finds a hover held for longer than the minimum', () => {
    const dwells = dwellPoints(hover(15))
    expect(dwells).toHaveLength(1)
    expect(dwells[0]?.seconds).toBe(15)
  })

  it('ignores a pause shorter than the minimum', () => {
    // Five seconds is turning round, not stopping.
    expect(dwellPoints(hover(5))).toHaveLength(0)
  })

  it('ignores a slow leg that is still above walking pace', () => {
    expect(dwellPoints(hover(20, DWELL_MAX_SPEED_MPS + 0.5))).toHaveLength(0)
  })

  it('sits the dot at the mean of the run rather than at its first fix', () => {
    const points = [at(0, 0.1, 51.0, -1.0), at(10, 0.1, 51.0, -1.0), at(20, 0.1, 52.0, -1.0)]
    const dwells = dwellPoints(points)
    expect(dwells[0]?.lat).toBeCloseTo(51.3333, 3)
  })

  it('does not join two slow runs across a reception gap', () => {
    // Low speed either side of a two-minute silence is not evidence that the
    // aircraft stayed put for two minutes.
    const points = [at(0, 0.1), at(5, 0.1), at(125, 0.1), at(130, 0.1)]
    expect(dwellPoints(points)).toHaveLength(0)
  })

  it('splits a hover interrupted by a fast leg into nothing when each half is short', () => {
    const points = [at(0, 0.1), at(5, 0.1), at(6, 12), at(7, 0.1), at(12, 0.1)]
    expect(dwellPoints(points)).toHaveLength(0)
  })
})
