/**
 * The two halves of a one-time explainer: the band, and the way back to it.
 *
 * The persistence is in `use-teaching.ts`; this file is only how it looks. A
 * page holds one `useTeaching(id)` and hands it to both, so the "?" appears
 * exactly when the band is gone and never alongside it.
 */
import { HelpCircleIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

import type { Teaching } from './use-teaching'

/**
 * The band itself. Renders nothing once dismissed — the way back is
 * `TeachingHelpButton`, placed next to what the band explains.
 */
export function TeachingBanner({
  teaching,
  title,
  titleId,
  children,
  className,
}: {
  teaching: Teaching
  /** Names the close button: "Dismiss the track state key". */
  title: string
  /** The id of the heading inside `children`, so the section is named by it. */
  titleId?: string
  children: ReactNode
  className?: string
}) {
  if (teaching.dismissed) return null

  return (
    <section
      aria-labelledby={titleId}
      className={cn('border-border bg-card/50 rounded-lg border px-3 py-2', className)}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        <button
          type="button"
          onClick={teaching.dismiss}
          aria-label={`Dismiss ${title}. It stays available from the question mark.`}
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-accent -mr-1 shrink-0',
            'focus-visible:ring-ring rounded p-1 transition-colors',
            'focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      </div>
    </section>
  )
}

/**
 * The way back. Visible only while the band is dismissed, so it is never a
 * second control competing with the thing it restores.
 */
export function TeachingHelpButton({
  teaching,
  title,
  className,
}: {
  teaching: Teaching
  title: string
  className?: string
}) {
  if (!teaching.dismissed) return null

  return (
    <button
      type="button"
      onClick={teaching.show}
      aria-label={`Show ${title}`}
      title={`Show ${title}`}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-accent inline-flex shrink-0',
        'focus-visible:ring-ring items-center gap-1 rounded p-1 transition-colors',
        'focus-visible:ring-2 focus-visible:outline-none',
        className,
      )}
    >
      <HelpCircleIcon className="size-3.5" aria-hidden />
    </button>
  )
}
