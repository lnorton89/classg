import { Link } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'

import { ClassGLogo } from '@/components/brand/classg-logo'
import { Toaster } from '@/components/ui/toast'
import { StatusButton } from '@/features/health/status-button'
import { TrackAlerts } from '@/features/monitoring/track-alerts'
import { NotificationsDrawer } from '@/features/notifications/notifications-drawer'
import { AccountMenu } from '@/features/auth/account-menu'
import { AuthGate } from '@/features/auth/auth-gate'
import { useHasRole } from '@/features/auth/use-auth'
import { AppUpdateBanner, OfflineBanner } from '@/features/offline/offline-banner'
import { cn } from '@/lib/cn'
import { LG_QUERY, useMediaQuery } from '@/lib/use-media-query'

import { useUnitEvents } from '@/features/deploy/use-unit-events'

import { BottomTabs } from './bottom-tabs'
import { CommandPalette } from './command-palette'
import { GLOBAL_SEARCH_INPUT_ID, GlobalSearch } from './global-search'
import { MockScenarioSwitcher } from './mock-scenario-switcher'
import { SideRail } from './side-rail'

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

/**
 * Chrome in two pieces: a rail down the left for where you can go, and a slim
 * bar across the top for what the system is doing and who you are.
 *
 * The bar used to carry both, and four destinations was all it could hold
 * beside the status cluster -- so Spectrum, Captures, the Event log, Settings
 * and Administration lived behind a gear, which is where features go to be
 * forgotten. Splitting the two questions apart gives each the shape it wants:
 * navigation is a list and belongs in a column, status is a handful of
 * indicators and belongs in a row. Below `lg` there is no room for a column,
 * so the bottom tabs stay and everything the four tabs cannot hold opens in a
 * sheet.
 */
function SignedInShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const isAdmin = useHasRole('admin')
  const wide = useMediaQuery(LG_QUERY)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      // ⌘K belongs to the search box now, not to the command palette: looking
      // an aircraft up is what the shortcut is reached for, and the palette
      // answered that with a substring match over a list of page names. The
      // palette keeps its place in the account menu, where its other half --
      // quick settings -- is what people open it for.
      //
      // Narrow screens have no visible box to focus, so the same keystroke
      // opens the sheet that contains one. A phone has no ⌘K, but a small
      // laptop window below 1024px does.
      if (wide) document.getElementById(GLOBAL_SEARCH_INPUT_ID)?.focus()
      else setMoreOpen(true)
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => globalThis.removeEventListener('keydown', onKeyDown)
  }, [wide])

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
            and navigation controls became AccountMenu. Now that the rail owns
            the destinations, the search box gets the width they used to take. */}
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

          {/* lg, matching the rail: below it the search lives in the "More"
              sheet, because a 360px row cannot hold a text field and the two
              status controls that answer "is this thing working". */}
          <GlobalSearch
            inputId={GLOBAL_SEARCH_INPUT_ID}
            className="ml-2 hidden max-w-sm flex-1 lg:block"
          />

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
            <MockScenarioSwitcher />
            <StatusButton />
            <NotificationsDrawer />
            <AccountMenu onOpenPalette={() => setPaletteOpen(true)} />
          </div>
        </div>

        {/* Inside the header so they stay put when the page scrolls. A warning
            that the screen has stopped updating is no use two screens up a
            track list. Both render nothing in the normal case. */}
        <OfflineBanner />
        <AppUpdateBanner />
      </header>

      {/* The rail and the page are siblings in a row, and the row -- not the
          page -- is what `min-h-0 flex-1` applies to, so the rail scrolls
          independently and <main> keeps the definite height the map needs. */}
      <div className="flex min-h-0 flex-1">
        <SideRail isAdmin={isAdmin} />

        {/* safe-pb-nav clears the fixed bottom nav and the home indicator under
            it; it collapses to 0 at lg, where the tabs are replaced by the rail. */}
        <main
          id="main"
          className="safe-pb-nav flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
        >
          {children}
        </main>
      </div>

      <BottomTabs isAdmin={isAdmin} moreOpen={moreOpen} onMoreOpenChange={setMoreOpen} />

      <UnitEvents />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <TrackAlerts />
      <Toaster />
    </div>
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
