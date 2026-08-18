/**
 * React bindings for the offline/staleness and update state.
 *
 * Separate from the components that use them so `offline-banner.tsx` exports
 * only components and stays hot-swappable, matching `live-context.ts` next to
 * `live-provider.tsx`.
 */
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { useLive } from '@/app/live-context'
import { useNow } from '@/app/use-format'
import { capturesQuery, healthQuery, spectrumSweepsQuery } from '@/lib/api/queries'

import { decideAutoApply } from './auto-apply'
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
  apply: () => void
  /** Keep this build; stops the countdown until the next one arrives. */
  decline: () => void
  /** Seconds until the update applies itself, or null when it will not. */
  secondsLeft: number | null
  /** Why it is waiting, when it is waiting on the unit rather than on you. */
  holdReason: string | null
}

/**
 * Whether a newer build is installed and waiting.
 *
 * Always 'idle' where there is no service worker — dev, an insecure origin, a
 * browser without support — so callers need no separate "is this a PWA" check.
 */
export function useAppUpdate(): AppUpdate {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [declined, setDeclined] = useState(false)
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

  const apply = useCallback(() => {
    watcher.current?.applyUpdate()
  }, [])

  // What the unit is busy with, which decides whether a reload is rude.
  // Polled queries rather than a subscription: this is read once a build is
  // waiting, which is rare, and both are already in the cache.
  const sweeps = useQuery(spectrumSweepsQuery())
  const captures = useQuery(capturesQuery())
  const sweepRunning = (sweeps.data?.sweeps ?? []).some((s) => s.state === 'running')
  const captureRunning = (captures.data?.captures ?? []).some((c) => c.state === 'running')

  // Re-decided whenever the tab is hidden or shown: backgrounding the console
  // is the moment a pending update becomes free to take.
  const hidden = usePageHidden()
  const decision =
    status === 'available'
      ? decideAutoApply({ hidden, sweepRunning, captureRunning, declined })
      : null
  const decisionKind = decision?.kind ?? null
  const countdownMs = decision?.kind === 'countdown' ? decision.ms : null

  // Both halves of the countdown live in one piece of state, written only
  // from the interval. A ref cannot be read during render and a synchronous
  // setState inside an effect cascades, so the timer owns it entirely.
  const [countdown, setCountdown] = useState<{ deadline: number; now: number } | null>(null)

  useEffect(() => {
    if (decisionKind !== 'countdown' || countdownMs === null) return
    let deadline = 0
    const id = setInterval(() => {
      const now = Date.now()
      // Set on the first tick rather than in the effect body, so nothing here
      // reads the clock during a render.
      if (deadline === 0) deadline = now + countdownMs - 250
      setCountdown({ deadline, now })
      if (now >= deadline) {
        clearInterval(id)
        watcher.current?.applyUpdate()
      }
    }, 250)
    return () => clearInterval(id)
  }, [decisionKind, countdownMs])

  useEffect(() => {
    // Nobody is looking, so there is nothing to count down in front of.
    if (decisionKind === 'now') watcher.current?.applyUpdate()
  }, [decisionKind])

  const secondsLeft =
    decisionKind !== 'countdown' || countdownMs === null
      ? null
      : countdown === null
        ? // Before the first tick, which is what the banner shows on the frame
          // it appears rather than a blank that fills in a moment later.
          Math.ceil(countdownMs / 1000)
        : Math.max(0, Math.ceil((countdown.deadline - countdown.now) / 1000))

  const decline = useCallback(() => setDeclined(true), [])

  return {
    status,
    apply,
    decline,
    secondsLeft,
    holdReason: decision?.kind === 'hold' ? decision.reason : null,
  }
}

/** document.hidden, as state. */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof document === 'undefined' ? false : document.hidden,
  )
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return hidden
}
