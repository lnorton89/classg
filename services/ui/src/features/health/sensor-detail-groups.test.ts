import { describe, expect, it } from 'vitest'

import { groupSensorDetail } from './sensor-detail-groups'

describe('groupSensorDetail', () => {
  it('sections known keys and keeps unknown ones renderable', () => {
    const groups = groupSensorDetail({
      zz_new_field: 42,
      iface: 'wlan-alfa',
      parse_errors: 0,
      frames: 191_354,
      survey_reason: 'the driver returned 98 survey entries',
    })

    expect(groups.map((g) => g.section)).toEqual([
      'Radio',
      'Traffic',
      'Errors',
      'Survey',
      'Other',
    ])
    const other = groups.find((g) => g.section === 'Other')
    expect(other?.rows).toEqual([
      { key: 'zz_new_field', label: 'zz new field', value: 42, kind: 'raw' },
    ])
  })

  it('orders rows within a section by declaration, not alphabet', () => {
    const traffic = groupSensorDetail({
      listening_fraction: 0.9,
      beacons: 10,
      frames: 20,
    }).find((g) => g.section === 'Traffic')
    expect(traffic?.rows.map((r) => r.key)).toEqual(['frames', 'beacons', 'listening_fraction'])
  })

  it('tags unit-bearing keys with their kind', () => {
    const rows = groupSensorDetail({
      uptime_s: 59979.8,
      hop_overhead_ms: 6_053_880,
      listening_fraction: 0.908,
      survey_reason: 'no occupancy to report',
    }).flatMap((g) => g.rows)
    const kinds = Object.fromEntries(rows.map((r) => [r.key, r.kind]))
    expect(kinds).toEqual({
      uptime_s: 'seconds',
      hop_overhead_ms: 'millis',
      listening_fraction: 'fraction',
      survey_reason: 'prose',
    })
  })

  it('omits sections with nothing in them', () => {
    expect(groupSensorDetail({ iface: 'wlan0' }).map((g) => g.section)).toEqual(['Radio'])
  })
})
