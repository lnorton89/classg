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
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { LiveContext, type LiveContextValue } from '@/app/live-context'
import { applyFrame } from '@/app/live-frames'
import { createFrameLogger, logConnection, logSessionStart } from '@/features/logs/log-bridge'
import { API_BASE } from '@/lib/api/client'
import { LiveStream, streamUrl, type ConnectionState } from '@/lib/api/live'
import { queryKeys } from '@/lib/api/queries'

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
