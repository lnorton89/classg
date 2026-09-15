import { describe, expect, it } from 'vitest'

import type { Track } from '@/lib/api/types'

import { filterFlights, flightFacets, searchableIdentity } from './flight-filters'

type Evidence = NonNullable<Track['evidence']>

function ev(cls: Evidence[number]['class'], count = 1): Evidence {
  return [{ class: cls, sensor_kind: 'wifi', weight: 0.6, count }]
}

function flight(overrides: Partial<Track> & { track_id: string }): Track {
  return {
    schema_version: '1.0',
    state: 'CLOSED',
    first_seen: '2026-09-15T09:00:00Z',
    last_seen: '2026-09-15T09:10:00Z',
    detection_count: 10,
    confidence: 0.6,
    ...overrides,
  }
}

const DJI_LONG = flight({
  track_id: 'dji-long',
  identity: { serial: 'S1', vendor: 'dji' },
  evidence: ev('A', 2302),
  detection_count: 2302,
  first_seen: '2026-09-15T09:00:00Z',
  last_seen: '2026-09-15T09:30:00Z',
  operator: { lat: 51.5, lon: -0.1 },
})
const DJI_SHORT = flight({
  track_id: 'dji-short',
  identity: { serial: 'S2', vendor: 'dji' },
  evidence: ev('A', 16),
  detection_count: 16,
  first_seen: '2026-09-14T09:00:00Z',
  last_seen: '2026-09-14T09:00:40Z',
})
const PARROT = flight({
  track_id: 'parrot',
  identity: { serial: 'S3', vendor: 'parrot' },
  evidence: ev('C', 8),
  detection_count: 8,
  first_seen: '2026-09-14T11:00:00Z',
  last_seen: '2026-09-14T11:06:00Z',
})

const ALL = [DJI_LONG, DJI_SHORT, PARROT]

describe('searchableIdentity', () => {
  it('flattens every identifier a person might paste in', () => {
    const text = searchableIdentity(
      flight({
        track_id: 'T1',
        identity: {
          serial: 'S1',
          vendor: 'dji',
          macs: ['aa:bb'],
          operator_id: 'OP1',
          manufacturer_code: '1581',
        },
      }),
    )
    expect(text).toContain('S1')
    expect(text).toContain('dji')
    expect(text).toContain('aa:bb')
    expect(text).toContain('OP1')
    expect(text).toContain('T1')
  })
})

describe('filterFlights', () => {
  it('matches the search box case-insensitively', () => {
    expect(filterFlights(ALL, { q: 'DJI' }, true).map((t) => t.track_id)).toEqual([
      'dji-long',
      'dji-short',
    ])
  })

  it('filters to one day on first_seen', () => {
    expect(filterFlights(ALL, { day: '2026-09-14' }, true).map((t) => t.track_id)).toEqual([
      'dji-short',
      'parrot',
    ])
  })

  it('ignores a malformed day rather than emptying the table', () => {
    expect(filterFlights(ALL, { day: 'tuesday' }, true)).toHaveLength(3)
  })

  it('filters by vendor, evidence class, operator, duration and detections', () => {
    expect(filterFlights(ALL, { vendor: 'parrot' }, true).map((t) => t.track_id)).toEqual([
      'parrot',
    ])
    expect(filterFlights(ALL, { evidence: 'C' }, true).map((t) => t.track_id)).toEqual([
      'parrot',
    ])
    expect(filterFlights(ALL, { operator: 'yes' }, true).map((t) => t.track_id)).toEqual([
      'dji-long',
    ])
    expect(filterFlights(ALL, { operator: 'no' }, true).map((t) => t.track_id)).toEqual([
      'dji-short',
      'parrot',
    ])
    expect(filterFlights(ALL, { minDurationS: 300 }, true).map((t) => t.track_id)).toEqual([
      'dji-long',
      'parrot',
    ])
    expect(filterFlights(ALL, { minDetections: 100 }, true).map((t) => t.track_id)).toEqual([
      'dji-long',
    ])
  })

  it('combines facets', () => {
    expect(
      filterFlights(ALL, { vendor: 'dji', minDurationS: 300 }, true).map((t) => t.track_id),
    ).toEqual(['dji-long'])
  })

  it('leaves one facet out when asked, which is what makes the counts useful', () => {
    // Counting against the fully filtered set would show 0 beside every vendor
    // but the selected one, so a facet could never be switched.
    expect(
      filterFlights(ALL, { vendor: 'parrot' }, true, 'vendor').map((t) => t.track_id),
    ).toEqual(['dji-long', 'dji-short', 'parrot'])
  })
})

describe('flightFacets', () => {
  it('counts each vendor over everything except the vendor facet itself', () => {
    const facets = flightFacets(ALL, { vendor: 'parrot' }, true)
    expect(facets.vendor).toEqual([
      { value: 'dji', label: 'dji', count: 2 },
      { value: 'parrot', label: 'parrot', count: 1 },
    ])
  })

  it('narrows the other facets by the current selection', () => {
    const facets = flightFacets(ALL, { vendor: 'dji' }, true)
    expect(facets.evidence).toEqual([{ value: 'A', label: 'Class A', count: 2 }])
  })

  it('counts a track once per class even when it has several entries of one', () => {
    const doubled = flight({
      track_id: 'doubled',
      evidence: [...ev('A'), ...ev('A')],
    })
    expect(flightFacets([doubled], {}, true).evidence).toEqual([
      { value: 'A', label: 'Class A', count: 1 },
    ])
  })

  it('splits operator located from not located', () => {
    expect(flightFacets(ALL, {}, true).operator).toEqual([
      { value: 'yes', label: 'Located', count: 1 },
      { value: 'no', label: 'Not located', count: 2 },
    ])
  })

  it('drops options that would return nothing', () => {
    // An unselected chip reading "0" is a control whose only purpose is to do
    // nothing.
    const facets = flightFacets([DJI_SHORT], {}, true)
    expect(facets.duration).toEqual([])
    expect(facets.detections.map((option) => option.value)).toEqual([10])
    expect(facets.operator).toEqual([{ value: 'no', label: 'Not located', count: 1 }])
  })

  it('keeps a selected option that has fallen to zero, so it can be cleared', () => {
    const facets = flightFacets([DJI_SHORT], { minDurationS: 900 }, true)
    expect(facets.duration).toEqual([{ value: 900, label: '≥ 15 min', count: 0 }])
  })
})
