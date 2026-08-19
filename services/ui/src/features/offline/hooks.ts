/**
 * React bindings for the offline/staleness and update state.
 *
 * Separate from the components that use them so `offline-banner.tsx` exports
 * only components and stays hot-swappable, matching `live-context.ts` next to
 * `live-provider.tsx`.
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { useLive } from '@/app/live-context'
import { useNow } from '@/app/use-format'
import { healthQuery } from '@/lib/api/queries'

import { computeFreshness, STALE_AFTER_MS, type Freshness } from './freshness'
import type { AppUpdateWatcher, UpdateStatus } from './app-update'
import { registerAppServiceWorker } from './register-sw'

/**
 * `navigator.onLine`, kept current.
 *
 * Worth being clear about what this is: the browser saying it has a network
 * interface, not that ClassG is reachable over it. A phone that has wandered
 * off the Pi's AP onto mobile data reports online and can reach nothing that
 * matters. That is why `useDataFreshness` weighs it against the stream state
 * rather than trusting it alone — but the false direction is the safe one:
 * offline is never wrong about being offline.
 */
function subscribeToConnectivity(onChange: () => void): () => void {
  globalThis.addEventListener('online', onChange)
  globalThis.addEventListener('offline', onChange)
  return () => {
    globalThis.removeEventListener('online', onChange)
    globalThis.removeEventListener('offline', onChange)
  }
}

export function useOnline(): boolean {
  // useSyncExternalStore rather than state seeded in an effect: it reads
  // `navigator.onLine` at subscribe time as well as on every event, so a phone
  // that dropped its connection between the first render and the subscription
  // cannot leave this stuck on `true` — which is the one direction this must
  // never be wrong in.
  return useSyncExternalStore(subscribeToConnectivity, () => navigator.onLine)
}

/**
 * How old the data on screen is, and whether that is worth saying out loud.
 *
 * The age is the newer of two clocks: the last frame off the WebSocket, and the
 * last successful health poll. Health is the right second source because it is
 * the one query that keeps polling when the socket is down (see
 * `healthQuery`) — so if REST works and only the socket died, the age reflects
 * that rather than accusing a working API of being unreachable.
 *
 * Ticks every second so the age advances on screen. A frozen "5m ago" on a
 * banner about staleness would be its own small lie, and this is the one place
 * in the app where that irony would actually mislead.
 */
export function useDataFreshness(staleAfterMs: number = STALE_AFTER_MS): Freshness {
  const { connection, lastFrameAt, reconnectAttempt } = useLive()
  const { dataUpdatedAt } = useQuery(healthQuery())
  const online = useOnline()
  const now = useNow(1000)

  const newest = Math.max(lastFrameAt ?? 0, dataUpdatedAt)
  return computeFreshness({
    online,
    connection,
    reconnectAttempt,
    lastUpdateAt: newest === 0 ? null : newest,
    now,
    staleAfterMs,
  })
}

export interface AppUpdate {
  status: UpdateStatus
}

/**
 * Whether a newer build is installed and waiting -- and if one is, it is taken
 * IMMEDIATELY.
 *
 * There is deliberately no countdown, no "Keep this one", and no hold while a
 * sweep or capture runs. Those existed to protect the operator's map view from
 * a surprise reload, and they bought that at the price of leaving an operator
 * looking at a stale build in front of a live sky, which is the worse failure
 * for a detector: what is on screen must be what the unit is actually running.
 * Sweeps and captures run in the API on the unit, not in this tab, so a reload
 * never costs a measurement -- only the map's current pan and zoom.
 *
 * Always 'idle' where there is no service worker -- dev, an insecure origin, a
 * browser without support -- so callers need no separate "is this a PWA" check.
 */
export function useAppUpdate(): AppUpdate {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const watcher = useRef<AppUpdateWatcher | null>(null)

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    let cancelled = false

    void registerAppServiceWorker().then((found) => {
      if (!found || cancelled) return
      watcher.current = found
      setStatus(found.getStatus())
      unsubscribe = found.subscribe(setStatus)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  // The moment one is waiting, take it. applyUpdate() is a no-op unless the
  // status is 'available', so this cannot double-apply while one is in flight.
  useEffect(() => {
    if (status === 'available') watcher.current?.applyUpdate()
  }, [status])

  return { status }
}
