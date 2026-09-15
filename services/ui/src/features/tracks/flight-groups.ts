/**
 * Flights collected under the airframe that flew them.
 *
 * Flightradar24's structure, inverted onto this data: the aircraft is the
 * heading, and each row under it is only the things that differ between its
 * flights. It replaces a list where the widest column — identity — carried the
 * least information because it was identical on fifteen consecutive rows.
 */
import type { Track } from '@/lib/api/types'

import { aircraftKey, aircraftLabel, flightEndMs, flightStartMs } from './flight-metrics'

export interface AircraftGroup {
  /** Stable across renders: what the collapse state is keyed on. */
  key: string
  /** Serial, else primary MAC, else track id. */
  label: string
  serial: string | null
  /** The primary MAC, shown as a secondary line when a serial is the label. */
  mac: string | null
  vendor: string | null
  uaType: string | null
  /** Input order is preserved, so the table's own sort still governs the rows. */
  flights: Track[]
  /** Earliest first_seen and latest last_seen across the group's flights. */
  firstSeenMs: number | null
  lastSeenMs: number | null
}

function firstString(values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value) return value
  }
  return null
}

/**
 * Group flights by airframe, newest-flying aircraft first.
 *
 * Identity fields are taken from the first flight that HAS one rather than from
 * the newest flight: a short contact often carries a serial and nothing else,
 * and letting it define the header would blank the vendor and UA type that
 * longer flights of the same airframe established.
 */
export function groupByAircraft(tracks: Track[]): AircraftGroup[] {
  const groups = new Map<string, AircraftGroup>()

  for (const track of tracks) {
    const key = aircraftKey(track)
    const existing = groups.get(key)
    const startMs = flightStartMs(track)
    const endMs = flightEndMs(track)

    if (!existing) {
      groups.set(key, {
        key,
        label: aircraftLabel(track),
        serial: track.identity?.serial ?? null,
        mac: track.identity?.macs?.[0] ?? null,
        vendor: track.identity?.vendor ?? null,
        uaType: track.identity?.ua_type ?? null,
        flights: [track],
        firstSeenMs: startMs,
        lastSeenMs: endMs,
      })
      continue
    }

    existing.flights.push(track)
    existing.serial = firstString([existing.serial, track.identity?.serial])
    existing.mac = firstString([existing.mac, track.identity?.macs?.[0]])
    existing.vendor = firstString([existing.vendor, track.identity?.vendor])
    existing.uaType = firstString([existing.uaType, track.identity?.ua_type])
    if (startMs !== null && (existing.firstSeenMs === null || startMs < existing.firstSeenMs)) {
      existing.firstSeenMs = startMs
    }
    if (endMs !== null && (existing.lastSeenMs === null || endMs > existing.lastSeenMs)) {
      existing.lastSeenMs = endMs
    }
  }

  // Groups are ordered by their most recent flight, independently of the row
  // sort inside them: whatever column the table is sorted on, the aircraft that
  // flew last hour belongs above the one that flew last month.
  return [...groups.values()].sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0))
}
