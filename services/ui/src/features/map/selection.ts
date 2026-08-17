/**
 * Which contact the live view has selected.
 *
 * The map draws drones and manned traffic side by side, so "selected" has to
 * mean exactly one thing at a time: two highlights on one canvas leave the
 * operator guessing which one the panel is describing. That exclusion is
 * structural here — a single slot holding a kind and an id — rather than two
 * pieces of state that each have to remember to clear the other. The two
 * surfaces read the derived halves, which is what makes clicking a map marker
 * light up its row in the contacts panel and the reverse.
 *
 * Manned contacts are keyed by ICAO address, not detection id: the address is
 * the aircraft, a detection is one glimpse of it, and the map already dedupes
 * its manned markers by address for the same reason.
 */
import { useCallback, useMemo, useState } from 'react'

export interface ContactSelection {
  selectedTrackId: string | null
  selectedMannedIcao: string | null
  /** `null` clears the selection entirely. */
  selectTrack: (trackId: string | null) => void
  /** `null` clears the selection entirely. */
  selectManned: (icao: string | null) => void
}

export function useContactSelection(): ContactSelection {
  const [selected, setSelected] = useState<{ kind: 'drone' | 'manned'; id: string } | null>(
    null,
  )

  const selectTrack = useCallback((trackId: string | null) => {
    setSelected(trackId === null ? null : { kind: 'drone', id: trackId })
  }, [])

  const selectManned = useCallback((icao: string | null) => {
    setSelected(icao === null ? null : { kind: 'manned', id: icao })
  }, [])

  return useMemo(
    () => ({
      selectedTrackId: selected?.kind === 'drone' ? selected.id : null,
      selectedMannedIcao: selected?.kind === 'manned' ? selected.id : null,
      selectTrack,
      selectManned,
    }),
    [selected, selectTrack, selectManned],
  )
}
