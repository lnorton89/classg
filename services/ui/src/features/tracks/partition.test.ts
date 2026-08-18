import { describe, expect, it } from 'vitest'

import type { Track } from '@/lib/api/types'

import { partitionTracks } from './partition'

function track(trackId: string, state: Track['state'], evidence?: Track['evidence']): Track {
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
    ...(evidence ? { evidence } : {}),
  }
}

type Evidence = NonNullable<Track['evidence']>

function ev(cls: string, count = 1): Evidence {
  return [
    {
      class: cls as Evidence[number]['class'],
      sensor_kind: 'wifi',
      weight: cls === 'C' ? 0.1 : 0.6,
      count,
    },
  ]
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

  /*
   * The 2026-08-17 flight. A DJI-built access point on 5.8 GHz and the
   * aircraft's Remote ID beacon on 2.4 GHz are different radios with different
   * MACs, so fusion cannot merge them and the panel must not present them as
   * two aircraft.
   */
  it('keeps a vendor-only match out of the aircraft count', () => {
    const result = partitionTracks([
      track('remote-id', 'CONFIRMED', ev('A', 753)),
      track('access-point', 'TENTATIVE', ev('C', 8)),
    ])

    expect(result.active.map((item) => item.track_id)).toEqual(['remote-id'])
    expect(result.unidentified.map((item) => item.track_id)).toEqual(['access-point'])
  })

  it('promotes a vendor-only track once real evidence corroborates it', () => {
    const result = partitionTracks([
      track('promoted', 'CONFIRMED', [...ev('C', 8), ...ev('A', 12)]),
    ])

    expect(result.active.map((item) => item.track_id)).toEqual(['promoted'])
    expect(result.unidentified).toEqual([])
  })

  it('treats a missing evidence array as missing data, not weak data', () => {
    const result = partitionTracks([track('trimmed', 'CONFIRMED')])

    expect(result.active.map((item) => item.track_id)).toEqual(['trimmed'])
    expect(result.unidentified).toEqual([])
  })
})
