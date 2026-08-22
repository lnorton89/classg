import { Link } from '@tanstack/react-router'
import {
  HistoryIcon,
  MapIcon,
  RadarIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { ClassGLogo } from '@/components/brand/classg-logo'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { isApplePlatform } from '@/lib/platform'
import { Toaster } from '@/components/ui/toast'
import { Tooltip } from '@/components/ui/tooltip'
import { StatusButton } from '@/features/health/status-button'
import { TrackAlerts } from '@/features/monitoring/track-alerts'
import { NotificationsDrawer } from '@/features/notifications/notifications-drawer'
import { AccountMenu } from '@/features/auth/account-menu'
import { AuthGate } from '@/features/auth/auth-gate'
import { AppUpdateBanner, OfflineBanner } from '@/features/offline/offline-banner'
import { cn } from '@/lib/cn'

import { useUnitEvents } from '@/features/deploy/use-unit-events'

import { CommandPalette } from './command-palette'
import { MockScenarioSwitcher } from './mock-scenario-switcher'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  exact: boolean
}

/**
 * What you watch while the system is running. Settings is deliberately not
 * here: it is somewhere you go once to set the console up, so it sits in the
 * status cluster as a gear rather than spending width next to the live view.
 *
 * Logs and Docs used to live here too, which made this bar seven items — on a
 * phone that meant a bottom bar with two destinations ("what happened" and
 * "how does this work") competing for thumb space against the live tracking
 * screens the bar exists to keep one tap away. Neither is something an
 * operator reaches for mid-incident the way they reach for Live or Tracks, so
 * both moved into the account menu, which is already on screen at every
 * width. Spectrum is gone as a fifth destination for a different reason: it
 * was never its own subject, it was per-sensor detail (the SDR sweep, Wi-Fi
 * occupancy) that had been pulled out onto a page of its own. It lives inside
 * Sensors now, next to the sensor it measures.
 */
const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Live', icon: MapIcon, exact: true },
  { to: '/tracks', label: 'Tracks', icon: RadarIcon, exact: false },
  { to: '/timeline', label: 'Timeline', icon: HistoryIcon, exact: false },
  { to: '/sensors', label: 'Sensors', icon: SlidersHorizontalIcon, exact: false },
]

/**
 * The shell, gated.
 *
 * AuthGate wraps EVERYTHING, not just <main>. It used to sit inside <main> so
 * the login screen kept the header and logo, on the reasoning that a bare form
 * on a blank page looks like a different application. That reasoning was wrong,
 * and the header is exactly what makes it wrong: to someone who is not signed
 * in it was rendering system health, sensor state, stream status, whether the
 * unit was recording, the whole navigation, a command palette over everything
 * the app knows -- and TrackAlerts, which pops live drone detections as toasts.
 *
 * A login page must leak nothing. Nothing below this line mounts, fetches, or
 * renders until someone is signed in.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <SignedInShell>{children}</SignedInShell>
    </AuthGate>
  )
}

function SignedInShell({ children }: { children: ReactNode }) {
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
        {/* ONE row, at every width, and it never wraps.
            
            It used to wrap below xl, because nine controls do not fit a phone:
            brand, a scenario switcher, a recording pill, a bell, a stream
            badge, a health badge, a search box, an identity icon, a sign-out
            icon and a gear. Every one of them was justified on its own and the
            result was a clipped logo above two rows of chrome, on the screen
            with the least room for either.

            What fixed it was not tighter spacing. It was deciding that the
            header answers two questions -- is the system working, and who am I
            -- and that everything else is one tap inside one of those two
            answers. Four status controls became StatusButton; three identity
            and navigation controls became AccountMenu. */}
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4 xl:h-16">
          <Link
            to="/"
            aria-label="ClassG — go to the live map"
            className="focus-visible:outline-ring shrink-0 rounded-lg"
          >
            {/* The wordmark is on every screen now, including a phone.
                Hiding it below md dated from when this row carried nine
                controls and every pixel was contested; with three, the name of
                the thing you are looking at is worth more than the gap it
                used to leave. The tagline still waits for xl, where it has a
                line of its own to sit on rather than squeezing the mark. */}
            <ClassGLogo size="lg" className="xl:hidden" />
            <ClassGLogo size="lg" showTagline className="hidden xl:inline-flex" />
          </Link>

          {/* lg, not md: a tablet is a touch device and keeps the bottom bar,
              which shows every destination without eliding any. overflow-x-auto
              stays as the safety valve for whenever the list grows past what a
              phone's width divides evenly. */}
          <nav
            aria-label="Primary"
            className="ml-2 hidden min-w-0 justify-start gap-0.5 overflow-x-auto lg:flex"
          >
            {PRIMARY_NAV.map((item) => (
              <NavLink key={item.to} item={item} />
            ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
            <MockScenarioSwitcher />
            <StatusButton />
            <NotificationsDrawer />
            <PaletteButton onOpen={() => setPaletteOpen(true)} />
            <AccountMenu onOpenPalette={() => setPaletteOpen(true)} />
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
          'border-t backdrop-blur lg:hidden',
          // The insets go on the bar, the padding on the row inside it, so the
          // bar's background still reaches the bottom of the screen behind the
          // home indicator instead of leaving a strip of map showing.
          'safe-bottom safe-x',
        )}
      >
        <div className="flex items-stretch gap-0.5 px-1 py-1">
          {PRIMARY_NAV.map((item) => (
            <NavLink key={item.to} item={item} />
          ))}
        </div>
      </nav>

      {/* safe-pb-nav clears the fixed bottom nav and the home indicator under
          it; it collapses to 0 at lg, where the nav moves into the header. */}
      <main id="main" className="safe-pb-nav flex min-h-0 flex-1 flex-col overflow-y-auto">
        {children}
      </main>

      <UnitEvents />
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
        // `min-w-16` here plus `justify-around` on the bar used to mean the
        // nav needed more width than a phone has, back when it carried seven
        // destinations: Docs was pushed off the right edge with no way to
        // reach it. Equal flexible columns instead, so the bar divides
        // whatever width there is and every destination stays reachable down
        // to 320px, whatever the item count.
        'flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md px-0.5 py-1.5',
        // text-2xs, not a px literal: 12px is the documented floor, and rem
        // sizes are what let the --ui-scale text-size preference reach it.
        'text-2xs leading-tight font-medium tracking-tight transition-colors',
        // Stacked in the bottom bar, inline in the header. lg because that is
        // where the one becomes the other -- and there it sizes to its label
        // rather than sharing the row equally.
        'lg:flex-none lg:flex-row lg:gap-2 lg:px-2.5 lg:py-1.5 lg:text-sm lg:tracking-normal',
      )}
    >
      <item.icon className="size-4.5 shrink-0 lg:size-4" aria-hidden />
      <span className="max-w-full truncate">{item.label}</span>
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
        // Present at every width. It used to hide below md as "a keyboard
        // accelerator with no keyboard" -- but the palette is also the only
        // way to look a track up by serial or MAC, and hiding it left touch
        // devices with no search at all. The width argument dated from the
        // nine-control header; with three controls an icon costs nothing.
        className="inline-flex gap-2"
      >
        <SearchIcon aria-hidden />
        <span className="text-muted-foreground hidden text-xs 2xl:inline">Search</span>
        <Kbd className="hidden 2xl:inline-flex">{isApplePlatform() ? '⌘K' : 'Ctrl K'}</Kbd>
      </Button>
    </Tooltip>
  )
}

/**
 * A hook needs a component to live in, and this one belongs to the whole shell
 * rather than to any page: a deploy landing or the watchdog giving up is news
 * wherever the operator happens to be looking.
 */
function UnitEvents() {
  useUnitEvents()
  return null
}
