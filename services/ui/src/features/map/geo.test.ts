import { describe, expect, it } from 'vitest'

import type { Track } from '@/lib/api/types'

import { boundsOf, plottablePoints, trailGaps, trailsGeoJson } from './geo'

const baseTrack: Track = {
  schema_version: '1.0',
  track_id: 'track-1',
  state: 'CONFIRMED',
  first_seen: '2026-08-10T22:00:00Z',
  last_seen: '2026-08-10T22:01:00Z',
  detection_count: 3,
  confidence: 0.6,
}

describe('route bounds', () => {
  it('contains the complete history plus current and operator positions', () => {
    const track: Track = {
      ...baseTrack,
      history: [
        { lat: 46.0, lon: -122.9 },
        { lat: 46.2, lon: -122.7 },
      ],
      current: { lat: 46.1, lon: -122.8 },
      operator: { lat: 45.9, lon: -122.6 },
    }

    expect(boundsOf(plottablePoints([track]))).toEqual({
      west: -122.9,
      south: 45.9,
      east: -122.6,
      north: 46.2,
    })
  })
})

// Index access is `T | undefined` under noUncheckedIndexedAccess; a missing
// element is a test failure, not a value to optional-chain around.
function nth<T>(xs: readonly T[], i: number): T {
  const x = xs[i]
  if (x === undefined) throw new Error(`no element at index ${i}`)
  return x
}

describe('trail gaps', () => {
  // The flight measured on 2026-09-15: heard on the way out, silent for
  // 7m42s past Wi-Fi range, heard again on the way back.
  // Points are seconds apart within a leg, as fusion records them; only the
  // silence between the legs is long.
  const history = [
    { lat: 46.0386, lon: -122.768, at: '2026-09-15T06:08:44Z' },
    { lat: 46.037, lon: -122.762, at: '2026-09-15T06:09:00Z' },
    { lat: 46.0358, lon: -122.759, at: '2026-09-15T06:09:15Z' },
    { lat: 46.0371, lon: -122.7551, at: '2026-09-15T06:16:58Z' },
    { lat: 46.0385, lon: -122.768, at: '2026-09-15T06:17:10Z' },
  ]

  it('finds the silence between two recorded positions', () => {
    const gaps = trailGaps(history)
    expect(gaps).toHaveLength(1)
    expect(nth(gaps, 0).from).toBe(history[2])
    expect(nth(gaps, 0).to).toBe(history[3])
    expect(nth(gaps, 0).seconds).toBe(7 * 60 + 43)
  })

  it('does not call the hover-rate spacing between points a gap', () => {
    const steady = [
      { lat: 46.0, lon: -122.0, at: '2026-09-15T06:00:00Z' },
      { lat: 46.0001, lon: -122.0, at: '2026-09-15T06:00:29Z' },
      { lat: 46.0002, lon: -122.0, at: '2026-09-15T06:00:58Z' },
    ]
    expect(trailGaps(steady)).toEqual([])
  })

  it('draws the heard legs solid and the gap as its own dashed feature', () => {
    const track: Track = { ...baseTrack, history }
    const { features } = trailsGeoJson([track])
    expect(features).toHaveLength(2)

    const heard = nth(features, 0)
    expect(heard.properties?.gap).toBe(false)
    expect(heard.properties?.confidence).toBe(0.6)
    expect(heard.geometry.type).toBe('MultiLineString')
    const legs = (heard.geometry as GeoJSON.MultiLineString).coordinates
    expect(legs).toHaveLength(2)
    expect(nth(legs, 0)).toHaveLength(3)
    expect(nth(legs, 1)).toHaveLength(2)

    const gap = nth(features, 1)
    expect(gap.properties?.gap).toBe(true)
    expect(gap.properties?.gap_s).toBe(463)
    expect(gap.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-122.759, 46.0358],
        [-122.7551, 46.0371],
      ],
    })
  })

  it('keeps a single-point leg out of the solid trail but still bridges to it', () => {
    // Heard once on the far side of the gap, then nothing: a dot is not a leg,
    // yet the dashed bridge still shows where the aircraft was heard from.
    const track: Track = { ...baseTrack, history: history.slice(0, 4) }
    const { features } = trailsGeoJson([track])
    expect(features).toHaveLength(2)
    expect((nth(features, 0).geometry as GeoJSON.MultiLineString).coordinates).toHaveLength(1)
    expect(nth(features, 1).properties?.gap).toBe(true)
  })

  it('leaves an uninterrupted flight as one solid feature', () => {
    const track: Track = { ...baseTrack, history: history.slice(0, 3) }
    const { features } = trailsGeoJson([track])
    expect(features).toHaveLength(1)
    expect(nth(features, 0).properties?.gap).toBe(false)
    expect((nth(features, 0).geometry as GeoJSON.MultiLineString).coordinates).toEqual([
      [
        [-122.768, 46.0386],
        [-122.762, 46.037],
        [-122.759, 46.0358],
      ],
    ])
  })
})
