import { describe, expect, it } from 'vitest'

import {
  convertAltitudeFeet,
  convertLength,
  convertRange,
  convertSpeed,
  formatCoordinate,
  formatCoordinatePair,
} from './units'

describe('unit conversion', () => {
  it('leaves metric readings untouched', () => {
    // The wire format is SI, so metric display must be the recorded value with
    // nothing done to it — any drift here is a silent measurement error.
    expect(convertLength(122.4, 'metric')).toEqual({ value: 122.4, unit: 'm', digits: 1 })
    expect(convertSpeed(14.2, 'metric')).toEqual({ value: 14.2, unit: 'm/s', digits: 1 })
  })

  it('converts height to feet for both non-metric systems', () => {
    for (const system of ['aviation', 'imperial'] as const) {
      const converted = convertLength(100, system)
      expect(converted.unit).toBe('ft')
      expect(converted.value).toBeCloseTo(328.084, 3)
    }
  })

  it('uses knots for aviation and mph for imperial', () => {
    expect(convertSpeed(10, 'aviation').unit).toBe('kt')
    expect(convertSpeed(10, 'aviation').value).toBeCloseTo(19.438, 3)
    expect(convertSpeed(10, 'imperial').unit).toBe('mph')
    expect(convertSpeed(10, 'imperial').value).toBeCloseTo(22.369, 3)
  })

  it('switches range to a coarser unit at each system’s natural threshold', () => {
    expect(convertRange(999, 'metric').unit).toBe('m')
    expect(convertRange(1000, 'metric').unit).toBe('km')
    // One nautical mile, not one kilometre.
    expect(convertRange(1851, 'aviation').unit).toBe('ft')
    expect(convertRange(1852, 'aviation').unit).toBe('NM')
    expect(convertRange(1852, 'aviation').value).toBeCloseTo(1, 6)
    expect(convertRange(1609.344, 'imperial').unit).toBe('mi')
  })

  it('keeps ADS-B altitude in its native feet rather than round-tripping', () => {
    // Going feet → metres → feet would introduce error in a value that arrived
    // as feet in the first place.
    expect(convertAltitudeFeet(3500, 'aviation')).toEqual({
      value: 3500,
      unit: 'ft',
      digits: 0,
    })
    expect(convertAltitudeFeet(3500, 'metric').value).toBeCloseTo(1066.8, 1)
  })
})

describe('coordinate formatting', () => {
  it('keeps six decimals in decimal mode', () => {
    // Both protocols carry 1e-7 degree resolution; truncating discards real data.
    expect(formatCoordinate(51.4775, 'lat', 'decimal')).toBe('51.477500')
    expect(formatCoordinatePair(51.4775, -0.0014, 'decimal')).toBe('51.477500, -0.001400')
  })

  it('writes hemispheres rather than signs in DMS and DDM', () => {
    expect(formatCoordinate(51.4775, 'lat', 'dms')).toBe('51°28\'39.0" N')
    expect(formatCoordinate(-0.0014, 'lon', 'dms')).toBe('000°00\'05.0" W')
    expect(formatCoordinate(51.4775, 'lat', 'ddm')).toBe("51°28.650' N")
  })

  it('pads longitude to three degrees, as charts do', () => {
    expect(formatCoordinate(-0.0014, 'lon', 'ddm')).toBe("000°00.084' W")
  })

  it('renders a non-finite coordinate as absent, never as zero', () => {
    expect(formatCoordinate(Number.NaN, 'lat', 'decimal')).toBe('—')
  })
})
