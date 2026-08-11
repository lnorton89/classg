/**
 * Preferences provider: localStorage persistence plus the three side effects a
 * display preference can legitimately have on the document itself.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import {
  DEFAULT_PREFERENCES,
  PreferencesContext,
  TEXT_SCALE_VALUES,
  type Preferences,
} from './preferences-context'

const STORAGE_KEY = 'classg.preferences'

/**
 * Merge rather than replace. A stored blob written by an older build is missing
 * whatever keys have been added since, and a half-populated preferences object
 * would render `undefined m` in a table.
 */
function readStored(): Preferences {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFERENCES
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFERENCES
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES
    const merged = { ...DEFAULT_PREFERENCES, ...(parsed as Partial<Preferences>) }
    // The spread repairs a *missing* key but not a corrupt one. `Preferences`
    // declares `notifyCategories` as always present, and every consumer indexes
    // it without a guard on the strength of that — so a stored value that is
    // not an object (hand-edited storage, a shape change across versions) has
    // to be replaced here rather than allowed to reach a component and throw.
    if (!isPlainObject(merged.notifyCategories)) {
      merged.notifyCategories = DEFAULT_PREFERENCES.notifyCategories
    }
    return merged
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(readStored)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
    } catch {
      /* private mode — the in-memory preferences still apply */
    }
  }, [preferences])

  // Text size and density are CSS-level concerns, so they are applied to the
  // root element rather than threaded through every component.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--ui-scale', String(TEXT_SCALE_VALUES[preferences.textScale]))
    root.dataset.density = preferences.density
    if (preferences.motion === 'reduced') root.dataset.motion = 'reduced'
    else delete root.dataset.motion
  }, [preferences.textScale, preferences.density, preferences.motion])

  useEffect(() => {
    if (!preferences.keepAwake) return
    // Wake Lock is Chromium-and-Safari-only and requires a secure context, so
    // a rejection here is expected on some deployments rather than a fault.
    let sentinel: WakeLockSentinel | null = null
    let released = false

    const request = async () => {
      try {
        // lib.dom declares navigator.wakeLock as always present. It is not:
        // Firefox and older Safari have no Wake Lock API at all, so this
        // optional chain is what stops a TypeError, and the `?? null` is what
        // the short-circuit resolves to.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        sentinel = (await navigator.wakeLock?.request('screen')) ?? null
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (released) void sentinel?.release()
      } catch {
        sentinel = null
      }
    }

    // The lock is dropped whenever the tab is hidden; re-take it on return, or
    // the setting silently stops working after the first screen lock.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void request()
    }

    void request()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release().catch(() => undefined)
    }
  }, [preferences.keepAwake])

  const setPreference = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      setPreferences((old) => (old[key] === value ? old : { ...old, [key]: value }))
    },
    [],
  )

  const reset = useCallback(() => setPreferences(DEFAULT_PREFERENCES), [])

  const value = useMemo(
    () => ({ preferences, setPreference, reset }),
    [preferences, setPreference, reset],
  )

  return <PreferencesContext value={value}>{children}</PreferencesContext>
}
