/**
 * Binds the WebSocket stream to the TanStack Query cache.
 *
 * Two rules drive everything here:
 *
 *   1. High-frequency track updates go in via `setQueryData`, not
 *      `invalidateQueries`. A confirmed drone beacons at ~1 Hz and fusion may
 *      re-emit more often than that; refetching the whole list per tick would
 *      make the Pi serve the same JSON dozens of times a minute.
 *   2. On *every* successful connection — first or reconnect — the track list is
 *      refetched wholesale. The stream has no history, so a reconnect after a
 *      dropout leaves the cache holding tracks that may have closed and missing
 *      tracks that appeared. Patching cannot fix that; only a refetch can.
 */
import { useQueryClient } from '@tanstack/react-query'
import { createContext, use, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { createFrameLogger, logConnection, logSessionStart } from '@/features/logs/log-bridge'
import { API_BASE, normalizeTrack } from '@/lib/api/client'
import { LiveStream, streamUrl, type ConnectionState } from '@/lib/api/live'
import { queryKeys } from '@/lib/api/queries'
import type { DetectionsResponse, ServerFrame, Track, TracksResponse } from '@/lib/api/types'

export interface LiveContextValue {
  connection: ConnectionState
  /** Epoch ms of the last frame of any kind, or null if none yet. */
  lastFrameAt: number | null
  /** Pending reconnect attempt number; 0 when connected. */
  reconnectAttempt: number
}

const LiveContext = createContext<LiveContextValue>({
  connection: 'closed',
  lastFrameAt: null,
  reconnectAttempt: 0,
})

export function useLive(): LiveContextValue {
  return use(LiveContext)
}

export interface LiveProviderProps {
  children: ReactNode
  /** Injectable for tests. */
  createStream?: () => LiveStream
  enabled?: boolean
}

export function LiveProvider({ children, createStream, enabled = true }: LiveProviderProps) {
  const queryClient = useQueryClient()
  const [connection, setConnection] = useState<ConnectionState>('closed')
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const factoryRef = useRef(createStream)

  useEffect(() => {
    factoryRef.current = createStream
  }, [createStream])

  useEffect(() => {
    if (!enabled) return
    const stream = factoryRef.current
      ? factoryRef.current()
      : new LiveStream({ url: streamUrl(API_BASE) })

    // Its own closure state (last-known track and sensor shapes) is what lets
    // the event log record transitions rather than the 1 Hz frame stream.
    const logFrame = createFrameLogger()
    logSessionStart()

    const offState = stream.onStateChange((state) => {
      setConnection(state)
      setReconnectAttempt(stream.getAttempt())
      logConnection(state, stream.getAttempt())
    })

    const offConnect = stream.onConnect(() => {
      // The refetch that closes the history gap. Runs on first connect too, which
      // is harmless (the route loader has usually just fetched) and means there is
      // exactly one code path to reason about.
      void queryClient.invalidateQueries({ queryKey: ['tracks'] })
      void queryClient.invalidateQueries({ queryKey: ['detections'] })
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
    })

    const offFrame = stream.onFrame((frame) => {
      setLastFrameAt(Date.now())
      applyFrame(queryClient, frame)
      logFrame(frame)
    })

    stream.connect()
    return () => {
      offState()
      offConnect()
      offFrame()
      stream.close()
    }
  }, [queryClient, enabled])

  const value = useMemo<LiveContextValue>(
    () => ({ connection, lastFrameAt, reconnectAttempt }),
    [connection, lastFrameAt, reconnectAttempt],
  )

  return <LiveContext value={value}>{children}</LiveContext>
}

type QueryClientLike = ReturnType<typeof useQueryClient>

/** Exported for tests: pure-ish reducer over the cache for one server frame. */
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
