import { Link, useRouter, useRouterState } from '@tanstack/react-router'
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
import { useEffect, useRef, useState, type ReactNode } from 'react'

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
import { AppUpdateBanner, OfflineBanner } from '@/features/offline/offline-banner'
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

  // h-dvh, not min-h-dvh. A minimum lets this column grow to whatever its
  // content wants, and then `min-h-0 flex-1` on <main> has no upper bound to
  // shrink against -- so the map page ran 749px tall inside a 600px viewport,
  // pushing the map off the bottom of the screen while the contacts panel
  // scrolled the whole document instead of its own list.
  //
  // A definite height makes the shell the viewport, which is what an operator
  // console wants: the chrome stays put and the regions inside it scroll.
  // <main> carries overflow-y-auto so ordinary long pages -- settings, the docs
  // tree -- still scroll normally within it.
  return (
    <div className="bg-background flex h-dvh flex-col">
      <a href="#main" className="sr-only-focusable">
        Skip to main content
      </a>

      {/* safe-top/safe-x rather than padding on the row inside: the header's
          background has to reach under the status bar, only its contents move
          down. See the safe-area utilities in styles.css. */}
      <header
        className={cn(
          'border-border bg-card/85 sticky top-0 z-40 border-b backdrop-blur',
          'safe-top safe-x',
        )}
      >
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

          {/* Desktop only. The mobile bar is a sibling of the header, not a
              child of it -- see the note on it below. */}
          <nav aria-label="Primary" className="ml-3 hidden justify-start gap-0.5 md:flex">
            {PRIMARY_NAV.map((item) => (
              <NavLink key={item.to} item={item} />
            ))}
          </nav>

          {/* Sits on the logo's row at every width. It used to be `w-full`
              below xl, which bought a guaranteed second row and then still
              overflowed on a phone -- six items do not fit 360px -- so the gear
              wrapped alone onto a THIRD row. Three rows of chrome above a map
              on the screen with the least room for it. The cluster now shares
              the brand row, and the width comes from compacting its contents
              (see the Pause control) rather than from stacking. */}
          <div
            className={cn(
              'ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-1.5',
              'xl:w-auto xl:flex-none xl:shrink-0 xl:flex-nowrap',
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

        {/* Inside the header so they stay put when the page scrolls. A warning
            that the screen has stopped updating is no use two screens up a
            track list. Both render nothing in the normal case. */}
        <OfflineBanner />
        <AppUpdateBanner />
      </header>

      {/*
        Outside the header on purpose. The header carries `backdrop-blur`, and a
        backdrop-filter establishes a containing block for fixed descendants --
        so while this lived inside it, `bottom-0` resolved to the bottom of the
        header rather than of the viewport, and the bar rendered under the logo
        with the reserved 64px sitting empty at the foot of every page.
      */}
      <nav
        aria-label="Primary"
        className={cn(
          'border-border bg-card/95 fixed inset-x-0 bottom-0 z-40',
          'border-t backdrop-blur md:hidden',
          // The insets go on the bar, the padding on the row inside it, so the
          // bar's background still reaches the bottom of the screen behind the
          // home indicator instead of leaving a strip of map showing.
          'safe-bottom safe-x',
        )}
      >
        <div className="flex justify-around px-1 py-1">
          {PRIMARY_NAV.map((item) => (
            <NavLink key={item.to} item={item} />
          ))}
        </div>
      </nav>

      {/* safe-pb-nav clears the fixed mobile nav and the home indicator under
          it; it collapses to 0 at md, where the nav moves into the header. */}
      <main id="main" className="safe-pb-nav flex min-h-0 flex-1 flex-col overflow-y-auto">
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
  const router = useRouter()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const onSettings = pathname === '/settings' || pathname.startsWith('/settings/')

  // Whether this session opened settings from somewhere else, so the gear knows
  // whether "back" has anywhere to go. A deep link straight to /settings has no
  // previous page in this app, and `back()` there would leave the console.
  const openedFromInApp = useRef(false)
  const previous = useRef(pathname)
  useEffect(() => {
    const cameFromApp = !previous.current.startsWith('/settings')
    if (onSettings && cameFromApp) openedFromInApp.current = true
    if (!onSettings) openedFromInApp.current = false
    previous.current = pathname
  }, [pathname, onSettings])

  // A one-way gear is fine on a desktop, where settings is a page among pages
  // and the nav is always visible. On a phone it reads as a panel that opened
  // over everything, so tapping the control that opened it has to be what
  // shuts it -- otherwise the only way out is the browser's back button, and
  // people reasonably assume they are stuck.
  if (onSettings) {
    return (
      <Tooltip content="Close settings">
        <button
          type="button"
          aria-label="Close settings"
          aria-expanded
          onClick={() => {
            // Back, not a push to "/": pushing would make the phone's back
            // button walk straight into settings again, and it also loses
            // whichever page they were actually reading.
            if (openedFromInApp.current) router.history.back()
            else router.history.push('/')
          }}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            'bg-accent text-foreground',
          )}
        >
          <SettingsIcon className="size-4" aria-hidden />
        </button>
      </Tooltip>
    )
  }

  return (
    <Tooltip content="Settings — units, notifications, calibration">
      <Link
        to="/settings"
        aria-label="Settings"
        aria-expanded={false}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'text-muted-foreground hover:text-foreground',
        )}
      >
        <SettingsIcon className="size-4" aria-hidden />
      </Link>
    </Tooltip>
  )
}
