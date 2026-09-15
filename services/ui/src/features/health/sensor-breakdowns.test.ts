import { describe, expect, it } from 'vitest'

import { sensorBreakdowns } from './sensor-breakdowns'

describe('sensorBreakdowns', () => {
  it('turns a per-channel map into rows with bars', () => {
    const [dwell] = sensorBreakdowns({ dwell_share: { '1': 0.281, '6': 0.576, '11': 0.143 } })
    expect(dwell?.title).toBe('Dwell share by channel')
    expect(dwell?.entries.map((entry) => entry.label)).toEqual(['ch 1', 'ch 6', 'ch 11'])
    expect(dwell?.entries.map((entry) => entry.fraction)).toEqual([0.281, 0.576, 0.143])
  })

  it('sorts channels numerically, because 11 before 2 reads as corruption', () => {
    const [beacons] = sensorBreakdowns({
      beacons_per_channel: { '11': 1, '2': 2, '1': 3, '36': 4 },
    })
    expect(beacons?.entries.map((entry) => entry.label)).toEqual([
      'ch 1',
      'ch 2',
      'ch 11',
      'ch 36',
    ])
  })

  it('writes shares as percentages and counts as counts', () => {
    const [dwell] = sensorBreakdowns({ dwell_share: { '6': 0.576 } })
    expect(dwell?.entries[0]?.value).toBe('57.6%')
    const [beacons] = sensorBreakdowns({ beacons_per_channel: { '6': 8_100_000 } })
    expect(beacons?.entries[0]?.value).toBe((8_100_000).toLocaleString())
  })

  it('keeps every channel, where the comma list stopped at six', () => {
    const many = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [String(i + 1), i + 1]),
    )
    const [beacons] = sensorBreakdowns({ beacons_per_channel: many })
    expect(beacons?.entries).toHaveLength(14)
  })

  it('returns the three distributions in reading order', () => {
    const groups = sensorBreakdowns({
      drone_hits_per_channel: { '6': 1 },
      beacons_per_channel: { '6': 2 },
      dwell_share: { '6': 0.5 },
    })
    expect(groups.map((group) => group.key)).toEqual([
      'dwell_share',
      'beacons_per_channel',
      'drone_hits_per_channel',
    ])
  })

  it('omits a key the sensor did not send', () => {
    expect(sensorBreakdowns({ beacons: 10 })).toEqual([])
  })

  it('omits an empty map rather than heading a group with nothing under it', () => {
    // An empty "Dwell share" heading would claim the radio hopped nowhere.
    expect(sensorBreakdowns({ dwell_share: {} })).toEqual([])
  })

  it('ignores a map whose values are not numbers', () => {
    expect(sensorBreakdowns({ dwell_share: { '6': 'busy' } })).toEqual([])
  })

  it('clamps a negative counter, which would otherwise draw outside its track', () => {
    const [beacons] = sensorBreakdowns({ beacons_per_channel: { '6': -5, '1': 10 } })
    expect(beacons?.entries.find((entry) => entry.label === 'ch 6')?.fraction).toBe(0)
  })
})
