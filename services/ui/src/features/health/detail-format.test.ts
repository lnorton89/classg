import { describe, expect, it } from 'vitest'

import { formatDetailValue } from './detail-format'

describe('formatDetailValue', () => {
  it('never renders an object as [object Object]', () => {
    // The bug: three rows of the sensor panel -- beacons per channel, drone
    // hits per channel, dwell share -- showed "[object Object]" while claiming
    // to be telemetry.
    const values: unknown[] = [{ '5': 0.57, '6': 0.23 }, {}, { a: 1, b: 'two' }, [1, 2, 3]]
    for (const v of values) {
      expect(formatDetailValue(v)).not.toContain('[object Object]')
    }
  })

  it('summarises a dwell share as percentages, busiest first', () => {
    expect(formatDetailValue({ '6': 0.23, '5': 0.576, '1': 0.041 })).toBe(
      '5: 57.6%, 6: 23.0%, 1: 4.1%',
    )
  })

  it('keeps counts as counts rather than percentages', () => {
    expect(formatDetailValue({ '6': 120, '11': 19 })).toBe('6: 120, 11: 19')
  })

  it('caps a long ranking and says how much was left out', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`ch${i}`, 9 - i]))
    const out = formatDetailValue(many)
    expect(out).toContain('+3 more')
    // Silently truncating would misreport a radio's channel coverage.
    expect(out.startsWith('ch0: 9')).toBe(true)
  })

  it('reads an empty map as an answer, not as punctuation', () => {
    // No beacons on any channel yet is a real state, and "{}" does not say so.
    expect(formatDetailValue({})).toBe('none')
  })

  it('trims meaningless float precision', () => {
    expect(formatDetailValue(0.8618144163771155)).toBe('0.862')
    expect(formatDetailValue(15820)).toBe('15,820')
  })

  it('handles absent values', () => {
    expect(formatDetailValue(null)).toBe('—')
    expect(formatDetailValue(undefined)).toBe('—')
  })
})
