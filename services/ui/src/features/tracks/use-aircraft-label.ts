/**
 * Reading one aircraft's label.
 *
 * Kept out of aircraft-label.tsx so that file exports only components — the
 * same Fast Refresh rule that split `buttonVariants` out of `button.tsx`.
 *
 * The whole label set is fetched once and looked up here rather than one
 * request per serial: there are as many labels as there are aircraft an
 * operator has bothered to name, which is tens, and the Tracks list renders a
 * group header per aircraft. See `aircraftLabelsQuery`.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { aircraftLabelsQuery } from '@/lib/api/queries'
import type { AircraftLabel } from '@/lib/api/types'

/** The stored label for a serial, or null when it has none or none is loaded yet. */
export function useAircraftLabel(serial: string | null | undefined): AircraftLabel | null {
  const { data } = useQuery(aircraftLabelsQuery())
  if (!serial) return null
  return data?.labels.find((entry) => entry.serial === serial) ?? null
}

/**
 * The whole label set, keyed by serial.
 *
 * For callers that render a list of aircraft rather than one — the live
 * contacts panel groups every closed flight under its airframe, and a
 * `useAircraftLabel` per group would be a linear scan of the label set per
 * group on every repaint of a panel that redraws on a 5 s ticker.
 */
export function useAircraftLabels(): ReadonlyMap<string, AircraftLabel> {
  const { data } = useQuery(aircraftLabelsQuery())
  return useMemo(() => {
    const bySerial = new Map<string, AircraftLabel>()
    for (const entry of data?.labels ?? []) bySerial.set(entry.serial, entry)
    return bySerial
  }, [data])
}
