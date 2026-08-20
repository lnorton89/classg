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

/**
 * tier.ts says it MIRRORS corroboratingOnlyClasses in services/fusion/track.go,
 * and a mirror with nothing holding it flat is just a second implementation.
 * These pin the class list against fusion's, so the two cannot drift quietly.
 *
 * The empty case deliberately does NOT mirror Go, and that is worth a test of
 * its own so nobody "fixes" it into agreement. The two answer different
 * questions: fusion's identified() decides whether to PROMOTE a track, so
 * absence must not promote; this decides whether to DISPLAY one as identified,
 * and demoting on absence would hide a real aircraft whenever a response
 * arrives trimmed. Opposite defaults, each conservative for its own job.
 */
describe('identification mirrors fusion', () => {
  const base = {
    schema_version: '1.0',
    track_id: 'T1',
    state: 'CONFIRMED',
    first_seen: '2026-08-10T00:00:00Z',
    last_seen: '2026-08-10T00:00:01Z',
    detection_count: 1,
    confidence: 0.5,
    adsb_correlated: false,
  } as unknown as Track

  function withEvidence(classes: string[]): Track {
    return {
      ...base,
      evidence: classes.map((c) => ({
        class: c,
        sensor_kind: 'wifi',
        weight: 0.5,
        count: 1,
      })),
    } as unknown as Track
  }

  it('counts only the corroborating-only classes as insufficient', () => {
    // C, D and H corroborate but never identify -- the same three fusion lists
    // in corroboratingOnlyClasses.
    for (const c of ['C', 'D', 'H']) {
      const { active, unidentified } = partitionTracks([withEvidence([c])])
      expect(active, `class ${c} must not identify a track on its own`).toHaveLength(0)
      expect(unidentified).toHaveLength(1)
    }
    for (const c of ['A', 'B']) {
      const { active } = partitionTracks([withEvidence([c])])
      expect(active, `class ${c} identifies a track`).toHaveLength(1)
    }
    // One identifying class is enough, alongside any number of corroborators.
    expect(partitionTracks([withEvidence(['C', 'D', 'A'])]).active).toHaveLength(1)
  })

  it('shows a track with no evidence rather than hiding it', () => {
    // Deliberately the opposite of fusion's identified(), which returns false
    // here. See tier.ts: absence is missing data, not weak data, and this side
    // is choosing what an operator sees.
    expect(partitionTracks([{ ...base, evidence: [] }]).active).toHaveLength(1)
    expect(partitionTracks([base]).active).toHaveLength(1)
  })
})
