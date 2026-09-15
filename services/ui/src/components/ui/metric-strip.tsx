/**
 * The summary strip: a handful of numbers, big, above the detail.
 *
 * The track detail page had this and nothing else did, which is backwards —
 * the pages that most needed it were Sensors (a 40-row key-value dump with no
 * grouping by importance) and Live. What makes it work is the constraint, not
 * the styling: a strip is a claim about which four-to-six readings answer the
 * page's question, and everything below it is the working.
 *
 * Column counts are literal class names because Tailwind scans source text and
 * generates nothing for a name that only exists once a template is evaluated.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { StatTile, type StatTileProps } from '@/components/ui/stat'

export interface Metric extends StatTileProps {
  /** Stable identity for the tile. Labels repeat across sensors. */
  id: string
}

/**
 * How many tiles sit on one row at the widest breakpoint. Below `lg` the strip
 * is always two or three across, because a six-column grid on a phone is six
 * unreadable columns.
 */
const COLUMNS: Record<3 | 4 | 6, string> = {
  3: 'grid-cols-2 sm:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
  6: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6',
}

export function MetricStrip({
  metrics,
  columns = 6,
  className,
  label,
}: {
  metrics: Metric[]
  columns?: 3 | 4 | 6
  className?: string
  /** Names the group for a screen reader when the strip is not under a heading. */
  label?: ReactNode
}) {
  if (metrics.length === 0) return null

  return (
    <div
      // A list, because that is what it is: six unordered readings. Without a
      // role a screen reader gives no hint that the label and the number
      // belong together, or where one tile ends.
      role="group"
      aria-label={typeof label === 'string' ? label : undefined}
      data-density-strip
      className={cn('grid gap-2', COLUMNS[columns], className)}
    >
      {metrics.map(({ id, ...tile }) => (
        <StatTile key={id} {...tile} />
      ))}
    </div>
  )
}
