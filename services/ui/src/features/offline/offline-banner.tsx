import { TriangleAlertIcon, WifiOffIcon } from 'lucide-react'

import { cn } from '@/lib/cn'

import { useAppUpdate, useDataFreshness } from './hooks'

/**
 * The strip that says the screen has stopped being a reading.
 *
 * Sits between the header and the page rather than floating over it, and takes
 * real vertical space on purpose. The header's stream pill already carries this
 * as a badge; a badge is what you check, and by the time the console is
 * offline the operator is past checking things — they are looking at a map and
 * believing it. This is the one that interrupts.
 *
 * Nothing renders while the data is current, so it costs nothing in the normal
 * case, and `announce` keeps it away from the sub-30-second socket blips that
 * the backoff fixes on its own. A banner that appears every few minutes is
 * furniture within a week.
 */
export function OfflineBanner() {
  const freshness = useDataFreshness()
  if (!freshness.announce) return null

  const offline = freshness.level === 'offline'
  const Icon = offline ? WifiOffIcon : TriangleAlertIcon

  return (
    <div
      // Assertive: the entire point is to interrupt somebody who is reading the
      // map and would otherwise take it at face value.
      role="alert"
      aria-live="assertive"
      data-freshness={freshness.level}
      className={cn(
        'safe-x flex items-start gap-3 border-t px-3 py-2 sm:px-4',
        offline
          ? 'border-down/45 bg-down/12 border-l-down border-l-4'
          : 'border-warn/45 bg-warn/12 border-l-warn border-l-4',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', offline ? 'text-down' : 'text-warn')}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-tight font-semibold">{freshness.title}</p>
        <p className="text-foreground/75 mt-0.5 text-xs leading-snug">{freshness.detail}</p>
      </div>
    </div>
  )
}

/**
 * "There is a newer build on the unit" — and, usually, it takes it.
 *
 * It used to sit here until somebody pressed Reload, which on a console left
 * open on a wall for days meant running a build from three deploys ago with a
 * banner nobody had read. The unit deploys itself whenever CI goes green, so
 * that gap is now the normal case rather than the rare one.
 *
 * It still does not apply blindly. `auto-apply.ts` holds the policy and the
 * reasoning: immediately when the tab is hidden and nobody loses anything,
 * after a visible countdown when somebody is looking, and not at all while a
 * sweep or a capture is running -- a reload mid-sweep spends the operator's
 * ADS-B outage on the console updating itself and loses the measurement it
 * was paid for. The countdown is the consent, and "Keep this one" is the veto.
 */
export function AppUpdateBanner() {
  // Renders nothing, ever. A waiting build is applied the instant it exists
  // (see useAppUpdate), so there is no state to announce and nothing to ask
  // permission for. Kept as a component because the shell mounts it, and
  // because the hook must run somewhere to do the applying.
  useAppUpdate()
  return null
}
