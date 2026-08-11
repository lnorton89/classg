import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * The standard page frame for every route except the live map.
 *
 * Routes had drifted to three different widths -- tracks was full-bleed,
 * sensors capped at 6xl, config at 4xl, capture detail at 5xl -- so moving
 * between them shifted the content edges around. One container, one width.
 *
 * The live map (routes/index.tsx) is deliberately NOT wrapped: it fills the
 * viewport, and boxing it would waste the space the map exists to use.
 */
export function PageContainer({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        // max-w-384 is wide enough for the tracks table's columns without
        // letting text run to an unreadable measure on an ultrawide display.
        'mx-auto flex w-full max-w-384 flex-col gap-4 p-3 sm:p-4 lg:p-6',
        className,
      )}
    >
      {children}
    </div>
  )
}
