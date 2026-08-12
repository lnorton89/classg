/**
 * The cache reducer for one server frame.
 *
 * Separate from live-provider.tsx so that file exports only its component: a
 * module mixing a component with anything else cannot be hot-swapped by Fast
 * Refresh. Being its own module also makes the unit tests exercise it directly,
 * with no provider or socket in the way.
 */
import type { useQueryClient } from '@tanstack/react-query'

import { normalizeTrack } from '@/lib/api/client'
import { queryKeys } from '@/lib/api/queries'
import type { DetectionsResponse, ServerFrame, Track, TracksResponse } from '@/lib/api/types'

type QueryClientLike = ReturnType<typeof useQueryClient>

/** Pure-ish reducer over the cache for one server frame. */
export function applyFrame(queryClient: QueryClientLike, frame: ServerFrame): void {
  switch (frame.type) {
    case 'track.update': {
      const track = normalizeTrack(frame.track)
      queryClient.setQueryData(queryKeys.track(track.track_id), track)
      queryClient.setQueriesData<TracksResponse>({ queryKey: ['tracks', 'list'] }, (old) => {
        if (!old) return old
        const index = old.tracks.findIndex((t) => t.track_id === track.track_id)
        if (index === -1) {
          return { ...old, tracks: [...old.tracks, track], total: old.total + 1 }
        }
        const tracks = old.tracks.slice()
        tracks[index] = track
        return { ...old, tracks }
      })
      break
    }

    case 'track.closed': {
      queryClient.setQueryData<Track>(queryKeys.track(frame.track_id), (old) =>
        old ? { ...old, state: 'CLOSED' } : old,
      )
      queryClient.setQueriesData<TracksResponse>({ queryKey: ['tracks', 'list'] }, (old) => {
        if (!old) return old
        const index = old.tracks.findIndex((t) => t.track_id === frame.track_id)
        const existing = index === -1 ? undefined : old.tracks[index]
        if (!existing || existing.state === 'CLOSED') return old
        const tracks = old.tracks.slice()
        tracks[index] = { ...existing, state: 'CLOSED' }
        return { ...old, tracks }
      })
      break
    }

    case 'detection': {
      // Only ADS-B is cached from the stream. Raw detections are a debugging view
      // that fetches on demand; buffering every detection in memory would grow
      // without bound on a box with 4 GB of RAM.
      if (frame.detection.detection_class !== 'D') break
      queryClient.setQueriesData<DetectionsResponse>({ queryKey: ['detections'] }, (old) => {
        if (!old) return old
        const icao = frame.detection.adsb?.icao
        const rest = icao
          ? old.detections.filter((d) => d.adsb?.icao !== icao)
          : old.detections.filter((d) => d.detection_id !== frame.detection.detection_id)
        return { ...old, detections: [frame.detection, ...rest].slice(0, 200) }
      })
      break
    }

    case 'health': {
      queryClient.setQueryData(queryKeys.health, frame.health)
      // /sensors includes resolved runtime config that /health deliberately
      // omits. Do not overwrite that richer cache entry with heartbeat-only
      // data, or capture and restart controls silently lose their settings.
      break
    }

    case 'monitoring': {
      // Pushed rather than polled, so pausing on one browser is reflected
      // immediately on every other. Whether we are recording is not something
      // two open tabs should disagree about.
      queryClient.setQueryData(queryKeys.monitoring, frame.monitoring)
      break
    }

    case 'capture.status': {
      queryClient.setQueryData(queryKeys.capture(frame.capture.capture_id), frame.capture)
      void queryClient.invalidateQueries({ queryKey: queryKeys.captures })
      break
    }

    case 'ping':
      break
  }
}
