/**
 * The desktop left rail.
 *
 * Four destinations fitted in the header beside the status cluster; nine do
 * not, and the four that fitted were bought by hiding Spectrum, Captures, the
 * Event log, Settings and Administration behind a gear where nobody found
 * them. A column has room for all of them plus the divider that says which are
 * things you watch and which are things you change.
 *
 * Collapsible because the map wants the width back, and remembered per browser
 * so the choice is made once rather than on every visit.
 */
import { Link, useRouterState } from '@tanstack/react-router'
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react'
import { useState } from 'react'

import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'

import {
  isNavItemActive,
  NAV_ITEMS,
  visibleNavItems,
  type NavItem,
  type NavLocation,
} from './nav-items'

const STORAGE_KEY = 'classg.nav.rail-collapsed'

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
  } catch {
    /* the choice still applies for this session */
  }
}

export function SideRail({ isAdmin }: { isAdmin: boolean }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const location = useRouterState({ select: (state) => state.location }) as NavLocation
  const items = visibleNavItems(NAV_ITEMS, isAdmin)

  function toggle() {
    setCollapsed((old) => {
      writeCollapsed(!old)
      return !old
    })
  }

  return (
    <nav
      aria-label="Primary"
      data-collapsed={collapsed}
      className={cn(
        // hidden below lg: a tablet is a touch device and keeps the bottom
        // bar, which is the same decision the old header nav made.
        'border-border bg-card/40 hidden shrink-0 flex-col gap-1 border-r p-2 lg:flex',
        'safe-x overflow-y-auto',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <div className={cn('flex', collapsed ? 'justify-center' : 'justify-end')}>
        <Tooltip content={collapsed ? 'Expand the navigation' : 'Collapse the navigation'}>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? 'Expand the navigation' : 'Collapse the navigation'}
            aria-expanded={!collapsed}
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-accent rounded-md p-2',
              'transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            )}
          >
            {collapsed ? (
              <PanelLeftOpenIcon className="size-4" aria-hidden />
            ) : (
              <PanelLeftCloseIcon className="size-4" aria-hidden />
            )}
          </button>
        </Tooltip>
      </div>

      <ul className="flex flex-col gap-0.5">
        {items.map((item, index) => (
          <li key={item.id}>
            {/* The divider is the whole point of the two groups: above it is
                what the system is doing, below it is what you do to the
                system. */}
            {index > 0 && items[index - 1]?.group !== item.group ? (
              <hr className="border-border my-2" />
            ) : null}
            <RailLink
              item={item}
              collapsed={collapsed}
              active={isNavItemActive(item, location)}
            />
          </li>
        ))}
      </ul>
    </nav>
  )
}

function RailLink({
  item,
  collapsed,
  active,
}: {
  item: NavItem
  collapsed: boolean
  active: boolean
}) {
  return (
    <Link
      to={item.to}
      // `title`, not the Tooltip component: Tooltip wraps its child in an
      // inline-flex span, which inside the rail's column stops the row
      // stretching to the rail's width and leaves a collapsed icon with a
      // click target narrower than it looks. The label is in the accessible
      // name either way.
      title={collapsed ? `${item.label} — ${item.hint}` : undefined}
      // Computed here rather than through the router's own activeProps: two
      // entries share the /sensors path and only one of them may light up.
      // See isNavItemActive.
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium',
        'transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        collapsed && 'justify-center px-0',
        active
          ? // Unmistakable, and not by colour alone: a left bar, the accent
            // ground, and full-strength text against the rail's muted rest.
            'bg-accent text-foreground relative before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <item.icon className="size-4.5 shrink-0" aria-hidden />
      {/* The label is never dropped from the accessible name, only from the
          picture: a collapsed rail of nine unnamed icons is a quiz. */}
      <span className={cn('min-w-0 truncate', collapsed && 'sr-only')}>{item.label}</span>
    </Link>
  )
}
