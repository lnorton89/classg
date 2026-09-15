/**
 * The phone's navigation: four tabs and a "More".
 *
 * The bottom bar divides its width equally between its items, so the number of
 * destinations it can carry is fixed by the narrowest screen rather than by
 * how many the app has. Four plus More is what fits at 320px with readable
 * labels; the rest — Spectrum, Captures, the Event log, Settings,
 * Administration — open in a sheet from the same thumb position, which is
 * where an operator's hand already is.
 *
 * Search is in the sheet too. It is the only way to look an aircraft up by
 * serial on a device with no keyboard shortcut to reach for.
 */
import { Dialog } from '@base-ui/react/dialog'
import { Link, useRouterState } from '@tanstack/react-router'
import { EllipsisIcon } from 'lucide-react'

import { cn } from '@/lib/cn'

import { GlobalSearch } from './global-search'
import {
  isNavItemActive,
  PRIMARY_NAV_ITEMS,
  SECONDARY_NAV_ITEMS,
  visibleNavItems,
  type NavItem,
  type NavLocation,
} from './nav-items'

export function BottomTabs({
  isAdmin,
  moreOpen,
  onMoreOpenChange,
}: {
  isAdmin: boolean
  moreOpen: boolean
  onMoreOpenChange: (open: boolean) => void
}) {
  const location = useRouterState({ select: (state) => state.location }) as NavLocation
  const rest = visibleNavItems(SECONDARY_NAV_ITEMS, isAdmin)
  // "More" is where the current page lives when it is not one of the four, so
  // the tab bar never claims the operator is nowhere.
  const restActive = rest.some((item) => isNavItemActive(item, location))

  return (
    <>
      {/*
        Outside the header on purpose. The header carries `backdrop-blur`, and a
        backdrop-filter establishes a containing block for fixed descendants --
        so while this lived inside it, `bottom-0` resolved to the bottom of the
        header rather than of the viewport, and the bar rendered under the logo
        with the reserved 64px sitting empty at the foot of every page.
      */}
      <nav
        // Named apart from the rail's "Primary": both are in the DOM at once
        // with CSS choosing between them, and two landmarks with one name is a
        // screen-reader list that cannot be navigated.
        aria-label="Primary tabs"
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
          {visibleNavItems(PRIMARY_NAV_ITEMS, isAdmin).map((item) => (
            <TabLink key={item.id} item={item} active={isNavItemActive(item, location)} />
          ))}
          <button
            type="button"
            onClick={() => onMoreOpenChange(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={restActive ? 'page' : undefined}
            className={cn(TAB_CLASS, restActive ? TAB_ACTIVE : TAB_INACTIVE)}
          >
            <EllipsisIcon className="size-4.5 shrink-0" aria-hidden />
            <span className="max-w-full truncate">More</span>
          </button>
        </div>
      </nav>

      <MoreSheet
        open={moreOpen}
        onOpenChange={onMoreOpenChange}
        items={rest}
        location={location}
      />
    </>
  )
}

const TAB_CLASS = cn(
  // `min-w-16` plus `justify-around` used to mean the bar needed more width
  // than a phone has: equal flexible columns instead, so it divides whatever
  // width there is and every destination stays reachable down to 320px.
  'flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md px-0.5 py-1.5',
  // text-2xs, not a px literal: 12px is the documented floor, and rem sizes
  // are what let the --ui-scale text-size preference reach it.
  'text-2xs leading-tight font-medium tracking-tight transition-colors',
)
const TAB_ACTIVE = 'text-foreground bg-accent'
const TAB_INACTIVE = 'text-muted-foreground hover:text-foreground hover:bg-accent/50'

function TabLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(TAB_CLASS, active ? TAB_ACTIVE : TAB_INACTIVE)}
    >
      <item.icon className="size-4.5 shrink-0" aria-hidden />
      <span className="max-w-full truncate">{item.label}</span>
    </Link>
  )
}

/**
 * A sheet rather than the centred `Dialog` wrapper: this is reached with a
 * thumb at the bottom of the screen, and a panel that opens in the middle of
 * the viewport puts its first item furthest from the finger that asked for it.
 */
function MoreSheet({
  open,
  onOpenChange,
  items,
  location,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: NavItem[]
  location: NavLocation
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            'bg-background/70 fixed inset-0 z-50 backdrop-blur-sm lg:hidden',
            'transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
          )}
        />
        <Dialog.Popup
          className={cn(
            'bg-popover text-popover-foreground border-border fixed z-50 flex flex-col',
            'inset-x-0 bottom-0 max-h-[85dvh] overflow-hidden rounded-t-xl border-t',
            'safe-bottom safe-x shadow-2xl lg:hidden',
            'transition-transform duration-150',
            'data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full',
          )}
        >
          <div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
            <Dialog.Title className="font-display text-sm font-bold">More</Dialog.Title>
            <Dialog.Close className="text-muted-foreground hover:text-foreground ml-auto rounded px-2 py-1 text-xs">
              Close
            </Dialog.Close>
          </div>

          <div className="border-border border-b p-3">
            <GlobalSearch focusOnMount onNavigate={() => onOpenChange(false)} />
          </div>

          <ul className="min-h-0 flex-1 overflow-y-auto p-2">
            {items.map((item) => {
              const active = isNavItemActive(item, location)
              return (
                <li key={item.id}>
                  <Link
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onOpenChange(false)}
                    className={cn(
                      'flex min-h-12 items-center gap-3 rounded-md px-3 py-2 transition-colors',
                      active
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                  >
                    <item.icon className="size-5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {item.label}
                      </span>
                      <span className="block truncate text-2xs">{item.hint}</span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
