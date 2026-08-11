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
    return { ...DEFAULT_PREFERENCES, ...(parsed as Partial<Preferences>) }
  } catch {
    return DEFAULT_PREFERENCES
  }
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
    root.dataset['density'] = preferences.density
    if (preferences.motion === 'reduced') root.dataset['motion'] = 'reduced'
    else delete root.dataset['motion']
  }, [preferences.textScale, preferences.density, preferences.motion])

  useEffect(() => {
    if (!preferences.keepAwake) return
    // Wake Lock is Chromium-and-Safari-only and requires a secure context, so
    // a rejection here is expected on some deployments rather than a fault.
    let sentinel: WakeLockSentinel | null = null
    let released = false

    const request = async () => {
      try {
        sentinel = (await navigator.wakeLock?.request('screen')) ?? null
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
