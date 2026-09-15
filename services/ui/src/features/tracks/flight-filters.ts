/**
 * Facet filtering for the flights list.
 *
 * Filtering is client-side over the loaded set because the API has no `vendor`,
 * `serial` or `until` parameter yet (phase 2 in docs/research/08-tracks-ux.md).
 * That is tolerable precisely because a closed-track page is at most a few
 * hundred rows — the same reasoning the Timeline page already relies on — and
 * it keeps the whole of phase 1 inside the UI.
 *
 * Every option carries a count, per NN/g: a filter that can return zero results
 * is a filter that wastes a click, and the counts are what stop that happening.
 */
import type { DetectionClass, Track } from '@/lib/api/types'

import { flightDurationS, hasOperatorFix } from './flight-metrics'
import { dayRangeMs } from './flight-time'

/** Everything a free-text search should match, flattened into one string. */
export function searchableIdentity(track: Track): string {
  return [
    track.identity?.serial,
    track.identity?.manufacturer_code,
    track.identity?.vendor,
    track.identity?.model_hint,
    track.identity?.operator_id,
    track.track_id,
    ...(track.identity?.macs ?? []),
  ]
    .filter(Boolean)
    .join(' ')
}

export interface FlightFilters {
  q?: string
  /** `YYYY-MM-DD` in the operator's zone — one bar of the histogram. */
  day?: string
  vendor?: string
  evidence?: DetectionClass
  operator?: 'yes' | 'no'
  minDurationS?: number
  minDetections?: number
}

export type FlightFacet = keyof FlightFilters

/** Thresholds, not a free numeric input: a chip with a count beats a spinner. */
export const DURATION_THRESHOLDS_S = [60, 300, 900] as const
export const DETECTION_THRESHOLDS = [10, 100, 1000] as const

function matchesFacet(
  track: Track,
  facet: FlightFacet,
  filters: FlightFilters,
  utc: boolean,
): boolean {
  switch (facet) {
    case 'q': {
      const q = filters.q?.trim().toLowerCase()
      if (!q) return true
      return searchableIdentity(track).toLowerCase().includes(q)
    }
    case 'day': {
      if (!filters.day) return true
      const range = dayRangeMs(filters.day, utc)
      if (!range) return true
      const startMs = Date.parse(track.first_seen)
      return Number.isFinite(startMs) && startMs >= range.startMs && startMs < range.endMs
    }
    case 'vendor':
      return !filters.vendor || track.identity?.vendor === filters.vendor
    case 'evidence':
      return (
        !filters.evidence ||
        (track.evidence ?? []).some((item) => item.class === filters.evidence)
      )
    case 'operator': {
      if (!filters.operator) return true
      return hasOperatorFix(track) === (filters.operator === 'yes')
    }
    case 'minDurationS': {
      const min = filters.minDurationS
      if (min === undefined) return true
      const seconds = flightDurationS(track)
      return seconds !== null && seconds >= min
    }
    case 'minDetections': {
      const min = filters.minDetections
      if (min === undefined) return true
      return track.detection_count >= min
    }
  }
}

const ALL_FACETS: FlightFacet[] = [
  'q',
  'day',
  'vendor',
  'evidence',
  'operator',
  'minDurationS',
  'minDetections',
]

/**
 * Apply every facet, optionally leaving one out.
 *
 * `except` is what makes the counts useful: a vendor chip's count has to be
 * "how many rows would I get if I picked this vendor instead", which means
 * counting against everything EXCEPT the vendor facet. Counting against the
 * fully filtered set would show 0 beside every vendor but the selected one.
 */
export function filterFlights(
  tracks: Track[],
  filters: FlightFilters,
  utc: boolean,
  except?: FlightFacet,
): Track[] {
  return tracks.filter((track) =>
    ALL_FACETS.every((facet) => facet === except || matchesFacet(track, facet, filters, utc)),
  )
}

export interface FacetOption<T extends string | number> {
  value: T
  label: string
  count: number
}

export interface FlightFacets {
  vendor: FacetOption<string>[]
  evidence: FacetOption<DetectionClass>[]
  operator: FacetOption<'yes' | 'no'>[]
  duration: FacetOption<number>[]
  detections: FacetOption<number>[]
}

function durationLabel(seconds: number): string {
  return seconds >= 3600
    ? `≥ ${seconds / 3600} h`
    : seconds >= 60
      ? `≥ ${seconds / 60} min`
      : `≥ ${seconds} s`
}

/**
 * The options each facet should offer, with the count each would produce.
 *
 * Options with a zero count are dropped rather than rendered disabled: an
 * unselected chip reading "0" is a control whose only purpose is to do nothing.
 * The currently selected option is always kept, so a filter can be cleared even
 * when it is the reason its own count fell to zero.
 */
export function flightFacets(
  tracks: Track[],
  filters: FlightFilters,
  utc: boolean,
): FlightFacets {
  const forVendor = filterFlights(tracks, filters, utc, 'vendor')
  const forEvidence = filterFlights(tracks, filters, utc, 'evidence')
  const forOperator = filterFlights(tracks, filters, utc, 'operator')
  const forDuration = filterFlights(tracks, filters, utc, 'minDurationS')
  const forDetections = filterFlights(tracks, filters, utc, 'minDetections')

  const vendorCounts = new Map<string, number>()
  for (const track of forVendor) {
    const vendor = track.identity?.vendor
    if (vendor) vendorCounts.set(vendor, (vendorCounts.get(vendor) ?? 0) + 1)
  }
  if (filters.vendor && !vendorCounts.has(filters.vendor)) vendorCounts.set(filters.vendor, 0)

  const evidenceCounts = new Map<DetectionClass, number>()
  for (const track of forEvidence) {
    const classes = new Set((track.evidence ?? []).map((item) => item.class))
    for (const cls of classes) evidenceCounts.set(cls, (evidenceCounts.get(cls) ?? 0) + 1)
  }
  if (filters.evidence && !evidenceCounts.has(filters.evidence)) {
    evidenceCounts.set(filters.evidence, 0)
  }

  const located = forOperator.filter(hasOperatorFix).length

  return {
    vendor: [...vendorCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: value, count })),
    evidence: [...evidenceCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: `Class ${value}`, count })),
    operator: [
      { value: 'yes' as const, label: 'Located', count: located },
      { value: 'no' as const, label: 'Not located', count: forOperator.length - located },
    ].filter((option) => option.count > 0 || filters.operator === option.value),
    duration: DURATION_THRESHOLDS_S.map((seconds) => ({
      value: seconds,
      label: durationLabel(seconds),
      count: forDuration.filter((track) => (flightDurationS(track) ?? -1) >= seconds).length,
    })).filter((option) => option.count > 0 || filters.minDurationS === option.value),
    detections: DETECTION_THRESHOLDS.map((min) => ({
      value: min,
      label: `≥ ${min}`,
      count: forDetections.filter((track) => track.detection_count >= min).length,
    })).filter((option) => option.count > 0 || filters.minDetections === option.value),
  }
}
