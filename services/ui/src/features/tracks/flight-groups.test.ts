import { describe, expect, it } from 'vitest'

import type { Track } from '@/lib/api/types'

import { groupByAircraft } from './flight-groups'

function flight(
  trackId: string,
  identity: Track['identity'],
  firstSeen: string,
  lastSeen: string,
): Track {
  return {
    schema_version: '1.0',
    track_id: trackId,
    state: 'CLOSED',
    first_seen: firstSeen,
    last_seen: lastSeen,
    detection_count: 1,
    confidence: 0.6,
    identity,
  }
}

const SERIAL = '1581F3YTBJ9H003045J0'

describe('groupByAircraft', () => {
  /*
   * The shape the live unit is in: 29 closed tracks, 15 of the first 17 for one
   * serial. Ungrouped, the widest column carries the least information.
   */
  it('collects every flight of one airframe under one header', () => {
    const groups = groupByAircraft([
      flight('a', { serial: SERIAL }, '2026-09-15T09:05:00Z', '2026-09-15T09:45:00Z'),
      flight('b', { serial: SERIAL }, '2026-09-14T23:16:00Z', '2026-09-14T23:25:00Z'),
      flight('c', { serial: 'OTHER' }, '2026-09-06T10:00:00Z', '2026-09-06T10:05:00Z'),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]?.label).toBe(SERIAL)
    expect(groups[0]?.flights.map((t) => t.track_id)).toEqual(['a', 'b'])
    expect(groups[1]?.flights.map((t) => t.track_id)).toEqual(['c'])
  })

  it('orders groups by their most recent flight, whatever the row order is', () => {
    const groups = groupByAircraft([
      flight('old', { serial: 'OLD' }, '2026-09-01T09:00:00Z', '2026-09-01T09:10:00Z'),
      flight('new', { serial: 'NEW' }, '2026-09-15T09:00:00Z', '2026-09-15T09:10:00Z'),
    ])
    expect(groups.map((g) => g.label)).toEqual(['NEW', 'OLD'])
  })

  it('preserves the incoming row order inside a group, so the table sort still governs', () => {
    const groups = groupByAircraft([
      flight('second', { serial: SERIAL }, '2026-09-14T09:00:00Z', '2026-09-14T09:10:00Z'),
      flight('first', { serial: SERIAL }, '2026-09-15T09:00:00Z', '2026-09-15T09:10:00Z'),
    ])
    expect(groups[0]?.flights.map((t) => t.track_id)).toEqual(['second', 'first'])
  })

  it('spans first_seen of the earliest flight to last_seen of the latest', () => {
    const groups = groupByAircraft([
      flight('a', { serial: SERIAL }, '2026-09-15T09:05:00Z', '2026-09-15T09:45:00Z'),
      flight('b', { serial: SERIAL }, '2026-09-04T23:16:00Z', '2026-09-04T23:25:00Z'),
    ])
    expect(groups[0]?.firstSeenMs).toBe(Date.parse('2026-09-04T23:16:00Z'))
    expect(groups[0]?.lastSeenMs).toBe(Date.parse('2026-09-15T09:45:00Z'))
  })

  it('takes each identity field from the first flight that has one', () => {
    // A short contact often carries only a serial; letting it define the header
    // would blank the vendor a longer flight of the same airframe established.
    const groups = groupByAircraft([
      flight('bare', { serial: SERIAL }, '2026-09-15T09:00:00Z', '2026-09-15T09:01:00Z'),
      flight(
        'rich',
        { serial: SERIAL, macs: ['aa:bb'], vendor: 'dji', ua_type: 'multirotor' },
        '2026-09-14T09:00:00Z',
        '2026-09-14T09:30:00Z',
      ),
    ])
    expect(groups[0]).toMatchObject({ vendor: 'dji', uaType: 'multirotor', mac: 'aa:bb' })
  })

  it('groups a serial-less track by its primary MAC', () => {
    const groups = groupByAircraft([
      flight('a', { macs: ['aa:bb'] }, '2026-09-15T09:00:00Z', '2026-09-15T09:10:00Z'),
      flight('b', { macs: ['aa:bb'] }, '2026-09-14T09:00:00Z', '2026-09-14T09:10:00Z'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('aa:bb')
  })

  it('keeps two anonymous contacts apart', () => {
    const groups = groupByAircraft([
      flight('a', {}, '2026-09-15T09:00:00Z', '2026-09-15T09:10:00Z'),
      flight('b', {}, '2026-09-14T09:00:00Z', '2026-09-14T09:10:00Z'),
    ])
    expect(groups).toHaveLength(2)
  })

  it('is empty for an empty list rather than producing a phantom group', () => {
    expect(groupByAircraft([])).toEqual([])
  })
})
