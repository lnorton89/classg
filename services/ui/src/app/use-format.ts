/**
 * Preference-aware formatting.
 *
 * `lib/format.ts` stays pure and preference-free — it is what the tests and the
 * non-React code use. This layer wraps it with the operator's unit, coordinate
 * and time choices, and is the only thing components should reach for.
 *
 * The rule from `format.ts` still governs everything here: never invent
 * precision the data does not have, and never render a placeholder that could
 * be mistaken for a measurement.
 */
import { useEffect, useMemo, useState } from 'react'

import { usePreferences } from '@/app/preferences-context'
import {
  EMPTY,
  formatBytes,
  formatConfidence,
  formatDuration,
  formatHeading,
  formatNumber,
  formatRelative,
  formatRssi,
  splitSerial,
} from '@/lib/format'
import {
  convertAltitudeFeet,
  convertLength,
  convertRange,
  convertSpeed,
  formatCoordinate,
  formatCoordinatePair,
  type Converted,
  type UnitSystem,
} from '@/lib/units'

function render(converted: Converted): string {
  return formatNumber(converted.value, { digits: converted.digits, unit: converted.unit })
}

/** Unit suffixes for column headers, so a cell need not repeat them per row. */
export interface UnitLabels {
  length: string
  range: string
  speed: string
}

export function unitLabels(system: UnitSystem): UnitLabels {
  return {
    length: system === 'metric' ? 'm' : 'ft',
    range: system === 'metric' ? 'km' : system === 'aviation' ? 'NM' : 'mi',
    speed: system === 'metric' ? 'm/s' : system === 'aviation' ? 'kt' : 'mph',
  }
}

export interface Formatters {
  /** Altitude / height AGL. */
  length: (metres: number | null | undefined) => string
  /** Ground distance; picks the coarser unit past a threshold. */
  range: (metres: number | null | undefined) => string
  speed: (mps: number | null | undefined) => string
  /** ADS-B altitude, which arrives in feet. */
  altitudeFeet: (feet: number | null | undefined) => string
  rssi: (dbm: number | null | undefined) => string
  heading: (deg: number | null | undefined) => string
  confidence: (value: number) => string
  duration: (seconds: number) => string
  bytes: (bytes: number) => string
  coord: (value: number, axis: 'lat' | 'lon') => string
  coords: (lat: number, lon: number) => string
  /** Wall clock in the chosen zone: "02:14:07" or "2:14:07 AM". */
  clock: (iso: string | null | undefined) => string
  /** The same, without seconds: "02:14" or "2:14 AM". For axes and labels. */
  clockBrief: (iso: string | null | undefined) => string
  /** Date and time, for anything that may not be from today. */
  timestamp: (iso: string | null | undefined) => string
  /** "18m ago". */
  relative: (iso: string | null | undefined) => string
  /** The operator's chosen combination of the two. */
  when: (iso: string | null | undefined) => string
  /** Suffix for the current zone, e.g. "UTC" — for column headers. */
  zoneLabel: string
  units: UnitLabels
  splitSerial: typeof splitSerial
}

export function useFormat(): Formatters {
  const { preferences } = usePreferences()
  const { units, coordFormat, clock, timeZone, timestampStyle } = preferences

  return useMemo<Formatters>(() => {
    const zone = timeZone === 'utc' ? 'UTC' : undefined
    const hour12 = clock === '12h'

    const timeFmt = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12,
      ...(zone ? { timeZone: zone } : {}),
    })
    // Hours and minutes only. An axis label is read at a glance and repeated
    // four or five times across a chart, and seconds on a 24-hour window are
    // three characters of noise per tick -- enough to push the outer labels
    // off the ends of the plot, which is exactly what they did.
    const briefFmt = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12,
      ...(zone ? { timeZone: zone } : {}),
    })
    const stampFmt = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12,
      ...(zone ? { timeZone: zone } : {}),
    })

    const parse = (iso: string | null | undefined): Date | null => {
      if (!iso) return null
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? null : date
    }

    const clockOf = (iso: string | null | undefined) => {
      const date = parse(iso)
      return date ? timeFmt.format(date) : EMPTY
    }

    const relativeOf = (iso: string | null | undefined) => formatRelative(iso)

    return {
      length: (metres) =>
        metres === null || metres === undefined || Number.isNaN(metres)
          ? EMPTY
          : render(convertLength(metres, units)),
      range: (metres) =>
        metres === null || metres === undefined || Number.isNaN(metres)
          ? EMPTY
          : render(convertRange(metres, units)),
      speed: (mps) =>
        mps === null || mps === undefined || Number.isNaN(mps)
          ? EMPTY
          : render(convertSpeed(mps, units)),
      altitudeFeet: (feet) =>
        feet === null || feet === undefined || Number.isNaN(feet)
          ? EMPTY
          : render(convertAltitudeFeet(feet, units)),
      rssi: formatRssi,
      heading: formatHeading,
      confidence: formatConfidence,
      duration: formatDuration,
      bytes: formatBytes,
      coord: (value, axis) => formatCoordinate(value, axis, coordFormat),
      coords: (lat, lon) => formatCoordinatePair(lat, lon, coordFormat),
      clock: clockOf,
      clockBrief: (iso) => {
        const date = parse(iso)
        return date ? briefFmt.format(date) : EMPTY
      },
      timestamp: (iso) => {
        const date = parse(iso)
        return date ? stampFmt.format(date) : EMPTY
      },
      relative: relativeOf,
      when: (iso) => {
        if (!iso) return EMPTY
        switch (timestampStyle) {
          case 'relative':
            return relativeOf(iso)
          case 'absolute':
            return clockOf(iso)
          case 'both': {
            const absolute = clockOf(iso)
            return absolute === EMPTY ? EMPTY : `${absolute} (${relativeOf(iso)})`
          }
        }
      },
      zoneLabel: timeZone === 'utc' ? 'UTC' : 'local',
      units: unitLabels(units),
      splitSerial,
    }
  }, [units, coordFormat, clock, timeZone, timestampStyle])
}

/**
 * Re-render on an interval so relative timestamps age on screen.
 *
 * Without this a "3s ago" written during a burst of traffic stays "3s ago"
 * until the next data frame — which, on a quiet sky, may be never. That is
 * precisely the situation where a stale age is most misleading.
 */
export function useTicker(intervalMs = 1000): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return tick
}

/**
 * `useTicker` for callers that need the clock itself rather than a nudge.
 *
 * Reading `Date.now()` in a render body makes the render impure — two renders
 * of the same props produce different output — which matters here because the
 * value feeds a decision, not just a label: the offline banner's threshold is
 * computed from it. Holding the time in state keeps the render a function of
 * its inputs, and moves "the clock advanced" to where it belongs, an event.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
