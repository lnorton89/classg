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
import type {
  DetectionsResponse,
  SensorHealth,
  ServerFrame,
  SpectrumSweepsResponse,
  Track,
  TracksQuery,
  TracksResponse,
} from '@/lib/api/types'

type QueryClientLike = ReturnType<typeof useQueryClient>

/**
 * Would the server have included this track in that list query's response?
 *
 * Every `['tracks', 'list']` cache entry carries its own filters in the key,
 * and appending a pushed track to all of them regardless used to leak
 * TENTATIVE tracks into the notifications drawer (which asks for
 * CONFIRMED/COASTING/CLOSED) and out-of-window tracks into the timeline's
 * `since` query -- each with a phantom `total` increment.
 */
function matchesQuery(track: Track, query: TracksQuery): boolean {
  if (query.state && query.state.length > 0 && !query.state.includes(track.state)) return false
  if (query.since && track.last_seen < query.since) return false
  if (query.min_confidence !== undefined && track.confidence < query.min_confidence)
    return false
  return true
}

/**
 * A session that runs for days accrues CLOSED tracks in every list cache
 * without bound -- nothing ever removes them, and the socket keeps appending.
 * Past this many closed entries the oldest are evicted, oldest `last_seen`
 * first. Active tracks are never evicted: fusion bounds those itself via the
 * track TTL. `total` is left alone -- the tracks still exist server-side, and
 * a reconnect refetches the whole list anyway.
 */
const MAX_CLOSED_PER_LIST = 500

function evictExcessClosed(tracks: Track[]): Track[] {
  const closed = tracks.filter((t) => t.state === 'CLOSED')
  if (closed.length <= MAX_CLOSED_PER_LIST) return tracks
  // By identity, not by timestamp. Comparing `last_seen > cutoff` evicts every
  // closed track SHARING the cutoff instant, and fusion closes tracks in
  // batches on one reap tick -- so a tie there dropped tens of entries where
  // two were meant to go.
  const doomed = new Set(
    closed
      .slice()
      .sort((a, b) => (a.last_seen < b.last_seen ? -1 : a.last_seen > b.last_seen ? 1 : 0))
      .slice(0, closed.length - MAX_CLOSED_PER_LIST)
      .map((t) => t.track_id),
  )
  return tracks.filter((t) => !doomed.has(t.track_id))
}

/** Pure-ish reducer over the cache for one server frame. */
export function applyFrame(queryClient: QueryClientLike, frame: ServerFrame): void {
  switch (frame.type) {
    case 'track.update': {
      const track = normalizeTrack(frame.track)
      queryClient.setQueryData(queryKeys.track(track.track_id), track)
      // getQueriesData rather than setQueriesData: the updater needs each
      // entry's own key to read the filters out of it.
      for (const [key, old] of queryClient.getQueriesData<TracksResponse>({
        queryKey: ['tracks', 'list'],
      })) {
        if (!old) continue
        const query = (key[2] ?? {}) as TracksQuery
        const matches = matchesQuery(track, query)
        const index = old.tracks.findIndex((t) => t.track_id === track.track_id)
        if (index === -1) {
          if (!matches) continue
          queryClient.setQueryData<TracksResponse>(key, {
            ...old,
            tracks: evictExcessClosed([...old.tracks, track]),
            total: old.total + 1,
          })
          continue
        }
        if (!matches) {
          // The update moved the track outside this query's filter (a state
          // change, in practice). Keeping the stale version would show a
          // reading the server no longer stands behind.
          queryClient.setQueryData<TracksResponse>(key, {
            ...old,
            tracks: old.tracks.filter((t) => t.track_id !== track.track_id),
            total: Math.max(0, old.total - 1),
          })
          continue
        }
        const tracks = old.tracks.slice()
        tracks[index] = track
        queryClient.setQueryData<TracksResponse>(key, { ...old, tracks })
      }
      break
    }

    case 'track.closed': {
      queryClient.setQueryData<Track>(queryKeys.track(frame.track_id), (old) =>
        old ? { ...old, state: 'CLOSED' } : old,
      )
      // Same filter rule as track.update above: closing a track can move it
      // out of a query that excludes CLOSED, and leaving it there would show a
      // reading the server no longer stands behind. getQueriesData, because the
      // filters live in each entry's own key.
      for (const [key, old] of queryClient.getQueriesData<TracksResponse>({
        queryKey: ['tracks', 'list'],
      })) {
        if (!old) continue
        const index = old.tracks.findIndex((t) => t.track_id === frame.track_id)
        const existing = index === -1 ? undefined : old.tracks[index]
        if (!existing || existing.state === 'CLOSED') continue
        const closed = { ...existing, state: 'CLOSED' as const }
        const query = (key[2] ?? {}) as TracksQuery
        if (!matchesQuery(closed, query)) {
          queryClient.setQueryData<TracksResponse>(key, {
            ...old,
            tracks: old.tracks.filter((t) => t.track_id !== frame.track_id),
            total: Math.max(0, old.total - 1),
          })
          continue
        }
        const tracks = old.tracks.slice()
        tracks[index] = closed
        queryClient.setQueryData<TracksResponse>(key, { ...old, tracks })
      }
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

      // /sensors is the same sensors with resolved runtime config attached, and
      // that config is exactly what /health omits -- so it is MERGED here
      // rather than overwritten. Overwriting silently drops the capture and
      // restart settings the sensor cards are built from; not updating at all
      // leaves every reading a sensor publishes waiting on a 15 s poll while
      // the header, fed by this same frame, has already moved on.
      //
      // Membership follows health, which is the authority on which sensors
      // exist. Config follows the cache, keyed by sensor_id, so a sensor that
      // appears mid-session simply has none until the next fetch.
      queryClient.setQueryData<SensorHealth[]>(queryKeys.sensors, (old) => {
        if (!old) return old
        const config = new Map(old.map((sensor) => [sensor.sensor_id, sensor.config]))
        return frame.health.sensors.map((sensor) => {
          const known = config.get(sensor.sensor_id)
          return known ? { ...sensor, config: known } : sensor
        })
      })
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

    case 'sweep.status': {
      const sweep = frame.sweep
      // The list, updated in place rather than invalidated: it is what drives
      // the "Sweeping…" state on the button, and a refetch would leave that
      // button wrong for a round trip.
      queryClient.setQueryData<SpectrumSweepsResponse>(queryKeys.spectrumSweeps, (old) => {
        if (!old) return old
        const index = old.sweeps.findIndex((s) => s.sweep_id === sweep.sweep_id)
        if (index === -1) return { ...old, sweeps: [sweep, ...old.sweeps] }
        const sweeps = [...old.sweeps]
        sweeps[index] = sweep
        return { ...old, sweeps }
      })

      // The DETAIL is invalidated, not written. This frame carries the record
      // and never the bins -- a completed wideband sweep is over a megabyte of
      // measurement -- so writing it into the detail cache would replace a
      // trace with a record that has none, and the chart would go blank at the
      // exact moment the measurement arrived.
      if (sweep.state !== 'running') {
        void queryClient.invalidateQueries({ queryKey: ['spectrum', 'sweep', sweep.sweep_id] })
        // A completed sweep gives the radio back, so what the unit can offer
        // changes with it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.spectrumBands })
      }
      break
    }

    case 'ping':
      break
  }
}
