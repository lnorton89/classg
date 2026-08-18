import type { Track } from '@/lib/api/types'

import { isIdentified } from './tier'

/**
 * Split tracks into the three things an operator reads differently.
 *
 * `active` is the headline: contacts something has actually identified as an
 * aircraft. `unidentified` is RF that merely looked drone-like — real enough to
 * show, never strong enough to count as a drone. Folding the second into the
 * first is how one aircraft came to read as two on 2026-08-17.
 */
export function partitionTracks(tracks: Track[]): {
  active: Track[]
  unidentified: Track[]
  closed: Track[]
} {
  const active: Track[] = []
  const unidentified: Track[] = []
  const closed: Track[] = []

  for (const track of tracks) {
    if (track.state === 'CLOSED') closed.push(track)
    else if (isIdentified(track)) active.push(track)
    else unidentified.push(track)
  }

  return { active, unidentified, closed }
}
