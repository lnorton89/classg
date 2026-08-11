import { Menu } from '@base-ui/react/menu'
import { Link } from '@tanstack/react-router'
import {
  BookOpenIcon,
  EllipsisIcon,
  MapIcon,
  MonitorIcon,
  MoonIcon,
  RadarIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SunIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { useTheme, type ThemePreference } from '@/app/theme-context'
import { ClassGLogo } from '@/components/brand/classg-logo'
import { Button } from '@/components/ui/button'
import { isApplePlatform, Kbd } from '@/components/ui/kbd'
import { Toaster } from '@/components/ui/toast'
import { Tooltip } from '@/components/ui/tooltip'
import { SystemStatusPill, StreamStatusPill } from '@/features/health/components'
import { FlightsDrawer } from '@/features/monitoring/flights-drawer'
import { RecordingIndicator } from '@/features/monitoring/recording-indicator'
import { TrackAlerts } from '@/features/monitoring/track-alerts'
import { cn } from '@/lib/cn'

import { CommandPalette } from './command-palette'
import { MockScenarioSwitcher } from './mock-scenario-switcher'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  exact: boolean
}

/**
 * Primary navigation is the four things you look at while the system is
 * running. Config, Settings and Docs are things you visit deliberately, so they
 * live in the overflow menu rather than competing for width with the live view.
 */
const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Live', icon: MapIcon, exact: true },
  { to: '/tracks', label: 'Tracks', icon: RadarIcon, exact: false },
  { to: '/sensors', label: 'Sensors', icon: SlidersHorizontalIcon, exact: false },
  { to: '/logs', label: 'Logs', icon: ScrollTextIcon, exact: false },
]

const SECONDARY_NAV: NavItem[] = [
  { to: '/config', label: 'Config', icon: SettingsIcon, exact: false },
  { to: '/settings', label: 'Settings', icon: SlidersHorizontalIcon, exact: false },
  { to: '/docs', label: 'Docs', icon: BookOpenIcon, exact: false },
]

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => globalThis.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <a href="#main" className="sr-only-focusable">
        Skip to main content
      </a>

      <header className="border-border bg-card/85 sticky top-0 z-40 border-b backdrop-blur">
        {/*
          One row from xl up, where brand + nav + status all fit. Below that it
          wraps rather than overflowing: none of the status cluster is
          droppable, because "am I recording" and "is the sensor alive" are the
          two questions the header exists to answer, and a header that scrolls
          sideways hides exactly those.
        */}
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5',
            'sm:px-4 xl:h-16 xl:flex-nowrap xl:py-0',
          )}
        >
          <Link
            to="/"
            aria-label="ClassG — go to the live map"
            className="focus-visible:outline-ring shrink-0 rounded-lg"
          >
            {/* The mark carries the identity on every screen; the wordmark and
                then the tagline are added as the width allows. */}
            <ClassGLogo size="lg" showWordmark={false} className="md:hidden" />
            <ClassGLogo size="lg" className="hidden md:inline-flex xl:hidden" />
            <ClassGLogo size="lg" showTagline className="hidden xl:inline-flex" />
          </Link>

          <nav
            aria-label="Primary"
            className={cn(
              'border-border bg-card/95 fixed inset-x-0 bottom-0 z-40 flex justify-around',
              'border-t px-1 py-1 backdrop-blur',
              'md:static md:ml-3 md:justify-start md:gap-0.5 md:border-t-0 md:bg-transparent',
              'md:p-0 md:backdrop-blur-none',
            )}
          >
            {PRIMARY_NAV.map((item) => (
              <NavLink key={item.to} item={item} />
            ))}
            {/* On mobile the overflow menu is the fifth item in the bottom bar,
                so every route stays reachable with one thumb. */}
            <OverflowMenu className="md:hidden" variant="nav" />
          </nav>

          <div
            className={cn(
              'ml-auto flex w-full flex-wrap items-center justify-end gap-1.5',
              'xl:w-auto xl:shrink-0 xl:flex-nowrap',
            )}
          >
            <MockScenarioSwitcher />
            <RecordingIndicator />
            <FlightsDrawer />
            <StreamStatusPill />
            <SystemStatusPill />
            <PaletteButton onOpen={() => setPaletteOpen(true)} />
            <OverflowMenu className="hidden md:inline-flex" variant="button" />
          </div>
        </div>
      </header>

      {/* pb-16 clears the fixed mobile nav; md:pb-0 once it moves into the header. */}
      <main id="main" className="flex min-h-0 flex-1 flex-col pb-16 md:pb-0">
        {children}
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <TrackAlerts />
      <Toaster />
    </div>
  )
}

function NavLink({ item }: { item: NavItem }) {
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.exact }}
      activeProps={{
        className: 'text-foreground bg-accent',
        'aria-current': 'page',
      }}
      inactiveProps={{
        className: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
      }}
      className={cn(
        'flex min-w-16 flex-col items-center gap-0.5 rounded-md px-3 py-1.5',
        'text-2xs font-medium transition-colors',
        'md:flex-row md:gap-2 md:px-2.5 md:py-1.5 md:text-sm',
      )}
    >
      <item.icon className="size-4.5 md:size-4" aria-hidden />
      {item.label}
    </Link>
  )
}

function PaletteButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip
      content={
        <span className="flex items-center gap-1.5">
          Search tracks, pages and settings
          <Kbd>{isApplePlatform() ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </span>
      }
    >
      <Button
        variant="outline"
        size="sm"
        onClick={onOpen}
        aria-label="Open the command palette"
        aria-keyshortcuts="Control+K Meta+K"
        // Desktop only. It is a keyboard accelerator with no keyboard to
        // accelerate on a phone, and the width it costs in the mobile header
        // pushes recording state and sensor health onto a second row.
        // Everything it reaches is in the bottom nav or the More menu.
        className="hidden gap-2 md:inline-flex"
      >
        <SearchIcon aria-hidden />
        <span className="text-muted-foreground hidden text-xs 2xl:inline">Search</span>
        <Kbd className="hidden 2xl:inline-flex">{isApplePlatform() ? '⌘K' : 'Ctrl K'}</Kbd>
      </Button>
    </Tooltip>
  )
}

const THEME_ORDER: ThemePreference[] = ['dark', 'light', 'system']
const THEME_ICON = { dark: MoonIcon, light: SunIcon, system: MonitorIcon }
const THEME_LABEL = {
  dark: 'Dark theme',
  light: 'Light theme',
  system: 'System theme',
}

/**
 * Everything that is not primary navigation: the deliberate routes, the theme
 * cycle, and the mock-scenario switcher in dev builds.
 */
function OverflowMenu({
  className,
  variant,
}: {
  className?: string
  variant: 'nav' | 'button'
}) {
  const { preference, setPreference } = useTheme()
  const ThemeIcon = THEME_ICON[preference]
  const nextTheme =
    THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length] ?? 'dark'

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="More pages and display options"
        className={cn(
          variant === 'nav'
            ? cn(
                'text-muted-foreground hover:text-foreground flex min-w-16 flex-col items-center',
                'gap-0.5 rounded-md px-3 py-1.5 text-2xs font-medium',
              )
            : cn(
                'text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-9',
                'items-center justify-center rounded-md transition-colors',
              ),
          className,
        )}
      >
        <EllipsisIcon className={variant === 'nav' ? 'size-4.5' : 'size-4'} aria-hidden />
        {variant === 'nav' ? 'More' : null}
      </Menu.Trigger>
      <Menu.Portal>
        {/* z-index on the Positioner: it carries the transform that creates the
            stacking context, so a z-index on the Popup would be trapped inside
            it and lose to the z-40 header. */}
        <Menu.Positioner
          side={variant === 'nav' ? 'top' : 'bottom'}
          align="end"
          sideOffset={6}
          className="z-50"
        >
          <Menu.Popup
            className={cn(
              'bg-popover text-popover-foreground border-border min-w-56 overflow-hidden',
              'rounded-lg border p-1 shadow-lg',
            )}
          >
            {/* Each label has to live inside its own Menu.Group: the label is
                what names the group for a screen reader, so Base UI throws
                rather than let one float free of the items it describes. */}
            <Menu.Group>
              <Menu.GroupLabel className="label-caps px-2 py-1.5">Pages</Menu.GroupLabel>
              {SECONDARY_NAV.map((item) => (
                <Menu.Item
                  key={item.to}
                  className="data-highlighted:bg-accent rounded-md"
                  render={
                    <Link
                      to={item.to}
                      className="flex items-center gap-2.5 px-2 py-2 text-sm"
                      activeProps={{ 'aria-current': 'page' }}
                    >
                      <item.icon className="text-muted-foreground size-4" aria-hidden />
                      {item.label}
                    </Link>
                  }
                />
              ))}
            </Menu.Group>

            <Menu.Separator className="bg-border my-1 h-px" />

            <Menu.Group>
              <Menu.GroupLabel className="label-caps px-2 py-1.5">Display</Menu.GroupLabel>
              <Menu.Item
                onClick={() => setPreference(nextTheme)}
                className={cn(
                  'flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-sm',
                  'data-highlighted:bg-accent',
                )}
              >
                <ThemeIcon className="text-muted-foreground size-4" aria-hidden />
                <span className="flex-1">{THEME_LABEL[preference]}</span>
                <span className="text-muted-foreground text-2xs">
                  → {THEME_LABEL[nextTheme].toLowerCase()}
                </span>
              </Menu.Item>
              <Menu.Item
                className="data-highlighted:bg-accent rounded-md"
                render={
                  <Link to="/settings" className="flex items-center gap-2.5 px-2 py-2 text-sm">
                    <SlidersHorizontalIcon
                      className="text-muted-foreground size-4"
                      aria-hidden
                    />
                    Units, time and text size
                  </Link>
                }
              />
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
