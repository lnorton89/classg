import type { Track } from '@/lib/api/types'

export function partitionTracks(tracks: Track[]): { active: Track[]; closed: Track[] } {
  const active: Track[] = []
  const closed: Track[] = []

  for (const track of tracks) {
    if (track.state === 'CLOSED') closed.push(track)
    else active.push(track)
  }

  return { active, closed }
}
