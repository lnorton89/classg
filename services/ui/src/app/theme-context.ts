import { createContext, use } from 'react'

export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export interface ThemeContextValue {
  preference: ThemePreference
  theme: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue>({
  preference: 'dark',
  theme: 'dark',
  setPreference: () => undefined,
})

export function useTheme(): ThemeContextValue {
  return use(ThemeContext)
}
