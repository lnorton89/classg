import { CloudDownloadIcon, TriangleAlertIcon, WifiOffIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
 * "There is a newer build on the unit."
 *
 * Polite rather than assertive, and it never applies itself: reloading takes
 * the map back to its default view and drops the operator's current selection,
 * which is a rude thing to do to somebody mid-observation. See `app-update.ts`
 * for why the new worker waits instead of skipping.
 */
export function AppUpdateBanner() {
  const { status, apply } = useAppUpdate()
  if (status === 'idle') return null

  const applying = status === 'applying'

  return (
    <div
      role="status"
      aria-live="polite"
      data-update-status={status}
      className="safe-x border-border bg-card flex items-center gap-3 border-t px-3 py-2 sm:px-4"
    >
      <CloudDownloadIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-xs leading-snug">
        <span className="text-foreground font-semibold">A newer ClassG build is ready.</span>{' '}
        <span className="text-muted-foreground">
          Reloading takes a moment and returns the map to its default view.
        </span>
      </p>
      <Button variant="outline" size="sm" onClick={apply} disabled={applying}>
        {applying ? 'Reloading…' : 'Reload'}
      </Button>
    </div>
  )
}
