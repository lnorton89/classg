/**
 * The app's destinations, in one list, shared by the desktop rail and the
 * phone's bottom bar + "More" sheet.
 *
 * It used to be four items in the header and everything else behind a gear:
 * Logs, Docs, Settings, Administration, Captures and Spectrum were each
 * reachable only if you already knew where they had been put. Four was the
 * right number for a bar that had to share a row with the status cluster; a
 * rail has a column to itself, so the constraint is gone and hiding half the
 * application behind an icon is no longer paying for anything.
 *
 * A phone still gets the handful that are looked at daily plus More: a bottom
 * bar divides the width equally between its items, and nine of them is nine
 * unreadable labels.
 */
import {
  ArchiveIcon,
  AudioWaveformIcon,
  MapIcon,
  RadarIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  id: string
  label: string
  /**
   * The route path, and nothing else — no search params. Every entry is a
   * destination of its own; see `isNavItemActive` for why two entries may not
   * share one route.
   */
  to: string
  icon: LucideIcon
  /** One line under the label in the More sheet, and the rail's tooltip when collapsed. */
  hint: string
  /** In the phone's bottom bar. Everything else is behind "More". */
  primary?: boolean
  /** Hidden from anyone without the administrator role. */
  adminOnly?: boolean
  /**
   * Which half of the rail. `watch` is what an operator looks at while the
   * system is running; `manage` is what they change about it. The divider
   * between them is the point of the distinction.
   */
  group: 'watch' | 'manage'
}

/**
 * "Flights", not "Tracks".
 *
 * The route stays `/tracks` — the URL is in bookmarks and in the operator
 * guide — but a track is fusion's internal object and a flight is the thing
 * that happened. The page has been about flights since the Tracks redesign;
 * only the nav label was still using the implementation's word.
 *
 * Timeline is not here, and its absence is the point. It was asking Flights'
 * question — what happened over this period — from a second page with its own
 * copy of the window, so the two drifted; it is `/tracks?view=lanes` now. A
 * destination whose answer is another destination's is not a destination, and
 * two rail entries cannot share one route in any case (see `isNavItemActive`).
 */
export const NAV_ITEMS: NavItem[] = [
  {
    id: 'live',
    label: 'Live',
    to: '/',
    icon: MapIcon,
    hint: 'What is up there now',
    primary: true,
    group: 'watch',
  },
  {
    id: 'flights',
    label: 'Flights',
    to: '/tracks',
    icon: RadarIcon,
    hint: 'Every flight this unit has recorded',
    primary: true,
    group: 'watch',
  },
  {
    id: 'sensors',
    label: 'Sensors',
    to: '/sensors',
    icon: SlidersHorizontalIcon,
    hint: 'Coverage and health, one radio at a time',
    primary: true,
    group: 'watch',
  },
  {
    id: 'spectrum',
    label: 'Spectrum',
    to: '/spectrum',
    icon: AudioWaveformIcon,
    hint: 'Sweep a band and compare it with the last one',
    group: 'watch',
  },
  {
    id: 'captures',
    label: 'Captures',
    to: '/captures',
    icon: ArchiveIcon,
    hint: 'PCAP and IQ recordings',
    group: 'watch',
  },
  {
    id: 'logs',
    label: 'Event log',
    to: '/logs',
    icon: ScrollTextIcon,
    hint: 'What this console has observed since it was opened',
    group: 'watch',
  },
  {
    id: 'settings',
    label: 'Settings',
    to: '/settings',
    icon: SettingsIcon,
    hint: 'Units, time, display, storage',
    group: 'manage',
  },
  {
    id: 'admin',
    label: 'Administration',
    to: '/admin',
    icon: ShieldCheckIcon,
    hint: 'Accounts, deployment, outbound hooks',
    adminOnly: true,
    group: 'manage',
  },
]

export const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => item.primary)

/** Everything the bottom bar cannot show, which is what "More" opens onto. */
export const SECONDARY_NAV_ITEMS = NAV_ITEMS.filter((item) => !item.primary)

export function visibleNavItems(items: NavItem[], isAdmin: boolean): NavItem[] {
  return items.filter((item) => !item.adminOnly || isAdmin)
}

export interface NavLocation {
  pathname: string
}

/** `/sensors` is under `/sensors`; `/sensors-old` is not. */
function underPath(pathname: string, base: string): boolean {
  if (base === '/') return pathname === '/'
  return pathname === base || pathname.startsWith(`${base}/`)
}

/**
 * Which rail entry the current URL belongs to.
 *
 * Path only, and every entry has a path of its own — which is why Captures is
 * a route rather than a pane of Sensors reached with `?view=captures`. The
 * router stamps `aria-current="page"` on any `Link` it considers active and
 * that stamp wins over anything the caller passes, so two entries pointing at
 * one route light both and make "where am I" unanswerable. One destination,
 * one entry; this function and the router then cannot disagree.
 *
 * A prefix match, not equality, so a flight's own page keeps Flights lit.
 */
export function isNavItemActive(item: NavItem, location: NavLocation): boolean {
  return underPath(location.pathname, item.to)
}
