import { describe, expect, it } from 'vitest'

import type { Track } from '@/lib/api/types'

import { partitionTracks } from './partition'

function track(trackId: string, state: Track['state']): Track {
  return {
    schema_version: '1.0',
    track_id: trackId,
    state,
    first_seen: '2026-08-10T00:00:00Z',
    last_seen: '2026-08-10T00:00:01Z',
    detection_count: 1,
    identity: {},
    confidence: 0.6,
    adsb_correlated: false,
  }
}

describe('partitionTracks', () => {
  it('keeps closed history out of the live set without discarding it', () => {
    const result = partitionTracks([
      track('tentative', 'TENTATIVE'),
      track('confirmed', 'CONFIRMED'),
      track('coasting', 'COASTING'),
      track('closed', 'CLOSED'),
    ])

    expect(result.active.map((item) => item.track_id)).toEqual([
      'tentative',
      'confirmed',
      'coasting',
    ])
    expect(result.closed.map((item) => item.track_id)).toEqual(['closed'])
  })
})
