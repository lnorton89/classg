/**
 * The settings left nav.
 *
 * Grouped by *who a change affects*, not by topic, and that grouping is the
 * whole point of the split. Everything under "This browser" is instant-apply,
 * private to this machine, and cannot alter a measurement — which is what makes
 * it safe to give those controls no Save button. Calibration changes the
 * instrument itself: it is stored on the Pi, shared by every client, and can
 * change what the system detects, so it keeps its explicit save-and-restart
 * flow and sits under a heading that says so.
 *
 * Merging the two into one page without that heading would be the mistake. The
 * separation used to be carried by the routes being different pages; now it is
 * carried here.
 */
import {
  BellIcon,
  CloudDownloadIcon,
  EyeIcon,
  GaugeIcon,
  InfoIcon,
  MapIcon,
  RadarIcon,
  RulerIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type SettingsScope = 'browser' | 'receiver'

export interface SettingsCategory {
  to: string
  label: string
  icon: LucideIcon
  /** One line, shown under the label in the nav on wide screens. */
  hint: string
  scope: SettingsScope
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    to: '/settings/general',
    label: 'General',
    icon: RulerIcon,
    hint: 'Units, coordinates, time',
    scope: 'browser',
  },
  {
    to: '/settings/appearance',
    label: 'Appearance',
    icon: EyeIcon,
    hint: 'Theme, text size, density',
    scope: 'browser',
  },
  {
    to: '/settings/notifications',
    label: 'Notifications',
    icon: BellIcon,
    hint: 'What reaches the drawer',
    scope: 'browser',
  },
  {
    to: '/settings/map',
    label: 'Live map',
    icon: MapIcon,
    hint: 'Legend and contacts panel',
    scope: 'browser',
  },
  {
    to: '/settings/tracks',
    label: 'Tracks',
    icon: RadarIcon,
    hint: 'Detail layout',
    scope: 'browser',
  },
  {
    to: '/settings/sensors',
    label: 'Sensors',
    icon: SlidersHorizontalIcon,
    hint: 'Restart confirmation',
    scope: 'browser',
  },
  {
    to: '/settings/logs',
    label: 'Logs',
    icon: ScrollTextIcon,
    hint: 'Buffer size and follow',
    scope: 'browser',
  },
  {
    to: '/settings/calibration',
    label: 'Calibration',
    icon: GaugeIcon,
    hint: 'Channel plan, fusion weights',
    scope: 'receiver',
  },
  // Separate from Calibration on purpose: calibration tunes what this receiver
  // already does with what it hears, while these decide what it reaches for.
  // One of them is the only outbound request the system makes.
  {
    to: '/settings/data',
    label: 'External data',
    icon: CloudDownloadIcon,
    hint: 'ADS-B, terrain, registries',
    scope: 'receiver',
  },
  // Reads the Pi rather than this browser, so it belongs with the receiver
  // group even though it changes nothing.
  {
    to: '/settings/about',
    label: 'About',
    icon: InfoIcon,
    hint: 'Build, configuration, host',
    scope: 'receiver',
  },
]

export const SCOPE_LABEL: Record<SettingsScope, string> = {
  browser: 'This browser',
  receiver: 'This receiver',
}

export const SCOPE_HINT: Record<SettingsScope, string> = {
  browser: 'Applied immediately, stored here, affects nobody else',
  receiver: 'Shared by every client, stored on the Pi, may need a restart',
}
