import { Link } from '@tanstack/react-router'
import {
  DiscAlbumIcon,
  MapIcon,
  MonitorIcon,
  MoonIcon,
  RadarIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SunIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { useTheme, type ThemePreference } from '@/app/theme'
import { Button } from '@/components/ui/button'
import { SystemStatusPill, StreamStatusPill } from '@/features/health/components'
import { cn } from '@/lib/cn'

import { MockScenarioSwitcher } from './mock-scenario-switcher'

const NAV = [
  { to: '/', label: 'Live', icon: MapIcon, exact: true },
  { to: '/tracks', label: 'Tracks', icon: RadarIcon, exact: false },
  { to: '/captures', label: 'Captures', icon: DiscAlbumIcon, exact: false },
  { to: '/sensors', label: 'Sensors', icon: SlidersHorizontalIcon, exact: false },
  { to: '/config', label: 'Config', icon: SettingsIcon, exact: false },
] as const

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <a href="#main" className="sr-only-focusable">
        Skip to main content
      </a>

      <header className="border-border bg-card/80 sticky top-0 z-40 border-b backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2 rounded">
            <RadarIcon className="text-primary size-5" aria-hidden />
            <span className="text-sm font-semibold tracking-tight">ClassG</span>
          </Link>

          <nav
            aria-label="Primary"
            className={cn(
              'border-border bg-card/95 fixed inset-x-0 bottom-0 z-40 flex justify-around border-t px-1 py-1 backdrop-blur',
              'md:bg-transparent md:static md:ml-4 md:justify-start md:gap-1 md:border-t-0 md:p-0 md:backdrop-blur-none',
            )}
          >
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                activeProps={{
                  className: 'text-foreground bg-accent',
                  'aria-current': 'page',
                }}
                inactiveProps={{ className: 'text-muted-foreground hover:text-foreground' }}
                className="flex min-w-16 flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-[11px] font-medium md:flex-row md:gap-2 md:text-sm"
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <MockScenarioSwitcher />
            <StreamStatusPill />
            <SystemStatusPill />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* pb-16 clears the fixed mobile nav; md:pb-0 once it moves into the header. */}
      <main id="main" className="flex min-h-0 flex-1 flex-col pb-16 md:pb-0">
        {children}
      </main>
    </div>
  )
}

const THEME_ORDER: ThemePreference[] = ['dark', 'light', 'system']
const THEME_ICON = { dark: MoonIcon, light: SunIcon, system: MonitorIcon }
const THEME_LABEL = {
  dark: 'Dark theme',
  light: 'Light theme',
  system: 'System theme',
}

function ThemeToggle() {
  const { preference, setPreference } = useTheme()
  const Icon = THEME_ICON[preference]
  const next = THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length] ?? 'dark'

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setPreference(next)}
      aria-label={`${THEME_LABEL[preference]}. Switch to ${THEME_LABEL[next].toLowerCase()}.`}
    >
      <Icon aria-hidden />
    </Button>
  )
}
