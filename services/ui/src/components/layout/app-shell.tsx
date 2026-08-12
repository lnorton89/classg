import { Link } from '@tanstack/react-router'
import {
  BookOpenIcon,
  MapIcon,
  RadarIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { ClassGLogo } from '@/components/brand/classg-logo'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Kbd } from '@/components/ui/kbd'
import { isApplePlatform } from '@/lib/platform'
import { Toaster } from '@/components/ui/toast'
import { Tooltip } from '@/components/ui/tooltip'
import { SystemStatusPill, StreamStatusPill } from '@/features/health/components'
import { RecordingIndicator } from '@/features/monitoring/recording-indicator'
import { TrackAlerts } from '@/features/monitoring/track-alerts'
import { NotificationsDrawer } from '@/features/notifications/notifications-drawer'
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
 * Everything you read while the system is running, plus the reference you read
 * when something on those pages needs explaining. Settings is deliberately not
 * here: it is somewhere you go once to set the console up, so it sits in the
 * status cluster as a gear rather than spending width next to the live view.
 */
const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Live', icon: MapIcon, exact: true },
  { to: '/tracks', label: 'Tracks', icon: RadarIcon, exact: false },
  { to: '/sensors', label: 'Sensors', icon: SlidersHorizontalIcon, exact: false },
  { to: '/logs', label: 'Logs', icon: ScrollTextIcon, exact: false },
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
          </nav>

          <div
            className={cn(
              'ml-auto flex w-full flex-wrap items-center justify-end gap-1.5',
              'xl:w-auto xl:shrink-0 xl:flex-nowrap',
            )}
          >
            <MockScenarioSwitcher />
            <RecordingIndicator />
            <NotificationsDrawer />
            <StreamStatusPill />
            <SystemStatusPill />
            <PaletteButton onOpen={() => setPaletteOpen(true)} />
            {/* Visible at every width, including mobile: the bottom bar is full
                at five pages, and settings is the one destination that has to
                stay reachable without one. */}
            <SettingsButton />
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
        // Everything it reaches is in the bottom nav or behind the gear.
        className="hidden gap-2 md:inline-flex"
      >
        <SearchIcon aria-hidden />
        <span className="text-muted-foreground hidden text-xs 2xl:inline">Search</span>
        <Kbd className="hidden 2xl:inline-flex">{isApplePlatform() ? '⌘K' : 'Ctrl K'}</Kbd>
      </Button>
    </Tooltip>
  )
}

/**
 * One gear, one destination.
 *
 * This replaced a three-dot menu that held Config, Settings and Docs behind a
 * click and a read. Two of those were settings pages that disagreed about which
 * was which, and the third was reference material with no business hiding in an
 * overflow — it is in the primary nav now. The theme cycle the menu also
 * carried lives in Settings › Appearance, and the command palette still
 * toggles it in one keystroke.
 */
function SettingsButton() {
  return (
    <Tooltip content="Settings — units, notifications, calibration">
      <Link
        to="/settings"
        aria-label="Settings"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'text-muted-foreground hover:text-foreground',
        )}
        activeProps={{ className: 'bg-accent text-foreground' }}
      >
        <SettingsIcon className="size-4" aria-hidden />
      </Link>
    </Tooltip>
  )
}
