/**
 * Operator preferences.
 *
 * Deliberately separate from calibration. Calibration is the *instrument*:
 * channel dwell weights and fusion confidence live on the server, are shared by
 * every client, and changing one changes what the system detects. Preferences
 * are the *display*: they live in this browser, affect nobody else, and can
 * never change a measurement — only how it is written down.
 *
 * Keeping them apart is what makes it safe to give preferences an unguarded,
 * instant-apply UI while calibration keeps its explicit save-and-restart flow.
 * The two now share the `/settings` page, so that separation is carried by the
 * scope grouping in `features/settings/categories.ts` rather than by the route.
 */
import { createContext, use } from 'react'

import type { LogLevel } from '@/features/logs/log-store'
import type { NotifyCategory } from '@/features/notifications/feed'
import type {
  ClockFormat,
  CoordFormat,
  TimestampStyle,
  TimeZoneMode,
  UnitSystem,
} from '@/lib/units'

export type TextScale = 'sm' | 'md' | 'lg' | 'xl'
export type Density = 'comfortable' | 'compact'
export type MotionPreference = 'system' | 'reduced'
/** Which new tracks are worth a sound when the operator is not looking. */
export type AlertLevel = 'off' | 'confirmed' | 'any'

export interface Preferences {
  units: UnitSystem
  coordFormat: CoordFormat
  clock: ClockFormat
  timeZone: TimeZoneMode
  timestampStyle: TimestampStyle
  textScale: TextScale
  density: Density
  motion: MotionPreference
  /** Ring buffer size for the event log. Bounded: this box has 4 GB of RAM. */
  logLimit: number
  /** Follow the tail of the log automatically as entries arrive. */
  logFollow: boolean
  alertLevel: AlertLevel
  /** Hold a screen wake lock so a tablet on a tripod does not sleep mid-watch. */
  keepAwake: boolean
  /** Require a confirmation step before restarting a sensor. */
  confirmDestructive: boolean
  /**
   * Which categories reach the notifications drawer. Stored as a partial record
   * on purpose: a category added by a later build is absent from an existing
   * stored blob, and absent has to mean "on" rather than "silently filtered".
   */
  notifyCategories: Partial<Record<NotifyCategory, boolean>>
  /** Severity floor for session events in the drawer. Drone detections bypass it. */
  notifyMinLevel: LogLevel
  /** Show the legend overlay on the live map. */
  mapLegend: boolean
  /** Show the closed-tracks section in the contacts panel. */
  showClosedContacts: boolean
}

export const TEXT_SCALE_VALUES: Record<TextScale, number> = {
  sm: 0.9375,
  md: 1,
  lg: 1.0625,
  xl: 1.125,
}

export const DEFAULT_PREFERENCES: Preferences = {
  // Metric matches the wire format, so the default display is the recorded
  // value with nothing done to it. Aviation units are one click away.
  units: 'metric',
  coordFormat: 'decimal',
  clock: '24h',
  // UTC by default: detections are correlated against logs and other sensors,
  // and a timestamp that means something different on each machine is a
  // timestamp that costs an hour during an incident review.
  timeZone: 'utc',
  timestampStyle: 'both',
  textScale: 'md',
  density: 'comfortable',
  motion: 'system',
  logLimit: 1000,
  logFollow: true,
  alertLevel: 'off',
  keepAwake: false,
  confirmDestructive: true,
  // Empty rather than every-key-true: "on" is the absence of an explicit no,
  // so a new category needs no migration to reach existing operators.
  notifyCategories: {},
  // Info, not debug. Debug entries are rate-limited bursts of detection noise —
  // useful in the log view, useless as notifications.
  notifyMinLevel: 'info',
  mapLegend: true,
  showClosedContacts: true,
}

export interface PreferencesContextValue {
  preferences: Preferences
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void
  reset: () => void
}

export const PreferencesContext = createContext<PreferencesContextValue>({
  preferences: DEFAULT_PREFERENCES,
  setPreference: () => undefined,
  reset: () => undefined,
})

export function usePreferences(): PreferencesContextValue {
  return use(PreferencesContext)
}
