import { describe, expect, it } from 'vitest'

import type { Track } from '@/lib/api/types'

import { boundsOf, plottablePoints } from './geo'

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
