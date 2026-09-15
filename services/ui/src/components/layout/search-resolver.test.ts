/**
 * What the header search box decides, without a DOM.
 *
 * The failure this guards against is quiet: an operator reads a serial off the
 * radio, types it, and lands on a list that merely contains the substring — or
 * worse, on nothing, because twenty hex characters looked like the front of a
 * ULID to whatever matched first.
 */
import { describe, expect, it } from 'vitest'

import type { AircraftLabel, SensorHealth, Track } from '@/lib/api/types'

import { buildSearchIndex, resolveSearch, type SearchIndex } from './search-resolver'

const ULID = '01K5ABCDEFGHJKMNPQRSTVWXYZ'

function index(overrides: Partial<SearchIndex> = {}): SearchIndex {
  return {
    trackIds: [ULID],
    serials: [
      { value: '1581F9DEC259E8296040', vendor: 'DJI', label: 'Survey drone' },
      { value: '15KG3AB1234567890ABC', vendor: 'Autel' },
    ],
    macs: [{ value: 'a4:2b:b0:11:22:33', vendor: 'DJI' }],
    sensors: [
      { id: 'wifi-0', kind: 'wifi' },
      { id: 'sdr-0', kind: 'sdr' },
    ],
    ...overrides,
  }
}

describe('resolveSearch', () => {
  it('returns nothing for an empty or blank query', () => {
    expect(resolveSearch('', index())).toEqual([])
    expect(resolveSearch('   ', index())).toEqual([])
  })

  it('sends a serial to that aircraft’s flights', () => {
    const [hit] = resolveSearch('1581F9DEC259E8296040', index())
    expect(hit?.kind).toBe('serial')
    expect(hit?.target).toEqual({ kind: 'flights', q: '1581F9DEC259E8296040' })
  })

  it('matches a serial without case, and on a fragment', () => {
    const [hit] = resolveSearch('c259e829', index())
    expect(hit?.label).toBe('1581F9DEC259E8296040')
    expect(hit?.target).toEqual({ kind: 'flights', q: '1581F9DEC259E8296040' })
  })

  it('sends a MAC to the flights list, punctuated or not', () => {
    // The same address is read off a screen with colons and typed without
    // them; both have to reach the same aircraft.
    for (const typed of ['a4:2b:b0:11:22:33', 'a42bb0112233', 'A4-2B-B0-11-22-33']) {
      const hit = resolveSearch(typed, index()).find((candidate) => candidate.kind === 'mac')
      expect(hit?.target).toEqual({ kind: 'flights', q: 'a4:2b:b0:11:22:33' })
    }
  })

  it('sends a ULID to the flight itself, not to a filtered list', () => {
    const [hit] = resolveSearch(ULID, index())
    expect(hit?.kind).toBe('track')
    expect(hit?.target).toEqual({ kind: 'track', trackId: ULID })
  })

  it('offers a ULID this browser has never seen, and says so', () => {
    const unseen = '01K5ZZZZZZZZZZZZZZZZZZZZZZ'
    const [hit] = resolveSearch(unseen, index())
    expect(hit?.target).toEqual({ kind: 'track', trackId: unseen })
    // The detail route has a "not found" page that says more than an empty
    // result list can, so the hit is offered rather than withheld.
    expect(hit?.detail).toMatch(/not in this session/)
  })

  it('resolves an operator’s label to the serial behind it', () => {
    const [hit] = resolveSearch('Survey drone', index())
    expect(hit?.kind).toBe('label')
    expect(hit?.label).toBe('Survey drone')
    // The flights list filters on the serial, never on the note somebody typed.
    expect(hit?.target).toEqual({ kind: 'flights', q: '1581F9DEC259E8296040' })
  })

  it('produces one row per aircraft even when label and serial both match', () => {
    const hits = resolveSearch('1581', index())
    expect(hits.filter((hit) => hit.label.includes('1581'))).toHaveLength(1)
  })

  it('sends a sensor id to that sensor’s pane', () => {
    const [hit] = resolveSearch('sdr-0', index())
    expect(hit?.kind).toBe('sensor')
    expect(hit?.target).toEqual({ kind: 'sensor', sensorId: 'sdr-0' })
  })

  it('puts an exact match ahead of a merely-containing one', () => {
    const hits = resolveSearch('wifi-0', {
      ...index(),
      sensors: [{ id: 'wifi-01' }, { id: 'wifi-0' }],
    })
    expect(hits[0]?.label).toBe('wifi-0')
  })

  it('caps the list rather than dumping the index into the header', () => {
    const many = Array.from({ length: 40 }, (_unused, i) => ({ value: `SERIAL${String(i)}` }))
    expect(resolveSearch('serial', { ...index(), serials: many })).toHaveLength(8)
  })
})

function track(overrides: Partial<Track> = {}): Track {
  return {
    schema_version: '1.0',
    track_id: ULID,
    state: 'CLOSED',
    first_seen: '2026-09-01T00:00:00Z',
    last_seen: '2026-09-01T00:05:00Z',
    detection_count: 10,
    confidence: 0.6,
    ...overrides,
  }
}

describe('buildSearchIndex', () => {
  it('folds repeated flights of one airframe into a single entry', () => {
    // The same aircraft flies seven times and every flight carries the same
    // serial; without the fold the box offers seven identical rows.
    const identity = { serial: 'S1', macs: ['aa:bb:cc:dd:ee:ff'], vendor: 'DJI' }
    const built = buildSearchIndex(
      [
        track({ track_id: 'T1', identity }),
        track({ track_id: 'T2', identity }),
        track({ track_id: 'T3', identity }),
      ],
      [],
      [],
    )
    expect(built.serials).toEqual([{ value: 'S1', vendor: 'DJI' }])
    expect(built.macs).toEqual([{ value: 'aa:bb:cc:dd:ee:ff', vendor: 'DJI' }])
    expect(built.trackIds).toEqual(['T1', 'T2', 'T3'])
  })

  it('carries the operator’s label onto the serial it belongs to', () => {
    const labels: AircraftLabel[] = [
      {
        serial: 'S1',
        label: 'Survey drone',
        flag: 'known',
        updated_at: '2026-09-01T00:00:00Z',
      },
    ]
    const built = buildSearchIndex([track({ identity: { serial: 'S1' } })], labels, [])
    expect(built.serials[0]?.label).toBe('Survey drone')
  })

  it('keeps a labelled aircraft that has not flown this session', () => {
    // The label is the only name an operator remembers, and an airframe that
    // last flew a week ago is exactly the one being looked up.
    const labels: AircraftLabel[] = [
      { serial: 'S9', label: 'Neighbour', flag: '', updated_at: '2026-09-01T00:00:00Z' },
    ]
    const built = buildSearchIndex([], labels, [])
    expect(resolveSearch('neighbour', built)[0]?.target).toEqual({ kind: 'flights', q: 'S9' })
  })

  it('ignores an empty label, which is a flag record with no name in it', () => {
    const labels: AircraftLabel[] = [
      { serial: 'S1', label: '', flag: 'watch', updated_at: '2026-09-01T00:00:00Z' },
    ]
    const built = buildSearchIndex([track({ identity: { serial: 'S1' } })], labels, [])
    expect(built.serials[0]?.label).toBeUndefined()
  })

  it('indexes the sensors by id and kind', () => {
    const sensors = [
      {
        sensor_id: 'wifi-0',
        sensor_kind: 'wifi',
        healthy: true,
        last_heartbeat: '2026-09-01T00:00:00Z',
        seconds_since_heartbeat: 1,
      },
    ] as SensorHealth[]
    expect(buildSearchIndex([], [], sensors).sensors).toEqual([{ id: 'wifi-0', kind: 'wifi' }])
  })
})
