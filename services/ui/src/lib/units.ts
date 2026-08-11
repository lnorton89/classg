/**
 * Unit systems.
 *
 * The wire format is always SI — metres, metres per second, degrees — because
 * that is what both Remote ID and DJI broadcast and converting at the storage
 * boundary would destroy the original reading. Conversion happens here, at the
 * last possible moment, and only for display.
 *
 * Three systems rather than the usual two. `aviation` exists because feet and
 * knots are what the airspace this tool watches is actually measured in: an
 * ADS-B contact reports feet, a CTAF call is in knots, and an operator
 * translating "142 m/s" in their head at night is an operator making mistakes.
 */

export type UnitSystem = 'metric' | 'imperial' | 'aviation'

export const UNIT_SYSTEMS: { value: UnitSystem; label: string; hint: string }[] = [
  { value: 'metric', label: 'Metric', hint: 'metres, m/s, kilometres' },
  { value: 'aviation', label: 'Aviation', hint: 'feet, knots, nautical miles' },
  { value: 'imperial', label: 'Imperial', hint: 'feet, mph, miles' },
]

const FEET_PER_METRE = 3.280839895013123
const KNOTS_PER_MPS = 1.9438444924406046
const MPH_PER_MPS = 2.2369362920544025
const NM_PER_METRE = 1 / 1852
const MILES_PER_METRE = 1 / 1609.344

export interface Converted {
  value: number
  unit: string
  /** Decimals appropriate to the unit — a foot needs fewer than a metre does. */
  digits: number
}

/** Altitude, height, and any other vertical or short-range distance. */
export function convertLength(metres: number, system: UnitSystem): Converted {
  if (system === 'metric') return { value: metres, unit: 'm', digits: 1 }
  return { value: metres * FEET_PER_METRE, unit: 'ft', digits: 0 }
}

/** Ground distance — operator offset, range rings, track length. */
export function convertRange(metres: number, system: UnitSystem): Converted {
  switch (system) {
    case 'metric':
      return metres >= 1000
        ? { value: metres / 1000, unit: 'km', digits: 2 }
        : { value: metres, unit: 'm', digits: 0 }
    case 'aviation':
      return metres >= 1852
        ? { value: metres * NM_PER_METRE, unit: 'NM', digits: 2 }
        : { value: metres * FEET_PER_METRE, unit: 'ft', digits: 0 }
    case 'imperial':
      return metres >= 1609.344
        ? { value: metres * MILES_PER_METRE, unit: 'mi', digits: 2 }
        : { value: metres * FEET_PER_METRE, unit: 'ft', digits: 0 }
  }
}

export function convertSpeed(mps: number, system: UnitSystem): Converted {
  switch (system) {
    case 'metric':
      return { value: mps, unit: 'm/s', digits: 1 }
    case 'aviation':
      return { value: mps * KNOTS_PER_MPS, unit: 'kt', digits: 0 }
    case 'imperial':
      return { value: mps * MPH_PER_MPS, unit: 'mph', digits: 0 }
  }
}

/** ADS-B reports feet natively; going via metres and back would only add error. */
export function convertAltitudeFeet(feet: number, system: UnitSystem): Converted {
  if (system === 'metric') return { value: feet / FEET_PER_METRE, unit: 'm', digits: 0 }
  return { value: feet, unit: 'ft', digits: 0 }
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export type CoordFormat = 'decimal' | 'dms' | 'ddm'

export const COORD_FORMATS: { value: CoordFormat; label: string; hint: string }[] = [
  { value: 'decimal', label: 'Decimal degrees', hint: '51.477500, -0.001400' },
  { value: 'ddm', label: 'Degrees + minutes', hint: "51°28.650' N, 0°00.084' W" },
  { value: 'dms', label: 'Degrees/min/sec', hint: '51°28\'39.0" N, 0°00\'05.0" W' },
]

function dmsParts(value: number): { deg: number; min: number; sec: number } {
  const abs = Math.abs(value)
  const deg = Math.floor(abs)
  const minFloat = (abs - deg) * 60
  const min = Math.floor(minFloat)
  return { deg, min, sec: (minFloat - min) * 60 }
}

/**
 * A single axis. Kept separate from the pair so a table can align latitude and
 * longitude in their own columns.
 *
 * Six decimals in decimal mode: both protocols carry 1e-7 degree resolution,
 * and truncating further would silently discard real precision.
 */
export function formatCoordinate(
  value: number,
  axis: 'lat' | 'lon',
  format: CoordFormat,
): string {
  if (!Number.isFinite(value)) return '—'
  if (format === 'decimal') return value.toFixed(6)

  const hemisphere = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W'
  const { deg, min, sec } = dmsParts(value)
  const pad = axis === 'lat' ? 2 : 3

  if (format === 'ddm') {
    const minutes = min + sec / 60
    return `${String(deg).padStart(pad, '0')}°${minutes.toFixed(3).padStart(6, '0')}' ${hemisphere}`
  }
  return `${String(deg).padStart(pad, '0')}°${String(min).padStart(2, '0')}'${sec
    .toFixed(1)
    .padStart(4, '0')}" ${hemisphere}`
}

export function formatCoordinatePair(lat: number, lon: number, format: CoordFormat): string {
  return `${formatCoordinate(lat, 'lat', format)}, ${formatCoordinate(lon, 'lon', format)}`
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export type ClockFormat = '24h' | '12h'
export type TimeZoneMode = 'local' | 'utc'

/**
 * How a moment is written when there is room for it.
 *
 *   relative  "18m ago" — fastest to read, worst for correlating with a log
 *   absolute  "02:14:07" — exact, but needs mental arithmetic to age
 *   both      absolute with the relative in parentheses
 *
 * `both` is the default: this interface's whole job is deciding whether data is
 * current, and that question needs the age, while writing an incident report
 * needs the wall-clock time.
 */
export type TimestampStyle = 'relative' | 'absolute' | 'both'

export const TIMESTAMP_STYLES: { value: TimestampStyle; label: string; hint: string }[] = [
  { value: 'both', label: 'Both', hint: '02:14:07 (18m ago)' },
  { value: 'relative', label: 'Relative', hint: '18m ago' },
  { value: 'absolute', label: 'Absolute', hint: '02:14:07' },
]
