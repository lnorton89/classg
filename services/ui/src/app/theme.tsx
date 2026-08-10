/**
 * Theme. Dark by default and dark on first paint — `index.html` ships
 * `class="dark"` so there is no white flash before hydration. This is used
 * outdoors at night; a full-screen white flash is a real problem, not a polish
 * item.
 */
import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'classg.theme'

interface ThemeContextValue {
  preference: ThemePreference
  theme: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: 'dark',
  theme: 'dark',
  setPreference: () => undefined,
})

export function useTheme(): ThemeContextValue {
  return use(ThemeContext)
}

function readStored(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'dark'
  const value = localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'system' || value === 'dark' ? value : 'dark'
}

function systemTheme(): ResolvedTheme {
  if (typeof globalThis.matchMedia !== 'function') return 'dark'
  return globalThis.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStored)
  const [systemValue, setSystemValue] = useState<ResolvedTheme>(systemTheme)

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return
    const query = globalThis.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystemValue(query.matches ? 'light' : 'dark')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const theme: ResolvedTheme = preference === 'system' ? systemValue : preference

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.classList.toggle('light', theme === 'light')
  }, [theme])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* private mode — the in-memory preference still applies */
    }
  }, [])

  const value = useMemo(
    () => ({ preference, theme, setPreference }),
    [preference, theme, setPreference],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}
