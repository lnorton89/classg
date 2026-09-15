/**
 * A key-value list with a heading, and a bar where the value is a share.
 *
 * Two problems, one component. The first is that a label on the left and its
 * value on the right lose their pairing once a run passes about five rows, and
 * the sensor page was running forty; a heading every few rows is what keeps a
 * run short. The second is that this app's most interesting numbers are
 * distributions — dwell share by channel, beacons by channel, detections by
 * receiver — and a distribution rendered as `6: 57.6%, 1: 28.1%, 11: 14.3%` is
 * a ranking the eye has to reconstruct from text. The bar is the ranking.
 *
 * `DataList`/`DataRow` in misc.tsx stay as they are: a flat list under five
 * rows needs neither of these, and most of the app's detail views are that.
 * This is the same row geometry, so the two can sit under one another.
 */
import type { ReactNode } from 'react'

import { BarMeter } from '@/components/ui/bar-meter'
import { cn } from '@/lib/cn'
import { EMPTY } from '@/lib/format'

export interface KeyValueEntry {
  /** Stable identity. Labels repeat between groups. */
  id: string
  label: ReactNode
  value: ReactNode
  /** Secondary line under the value — an age, a unit note, a caveat. */
  hint?: ReactNode
  /** Identifiers get the mono face; prose and measurements do not. */
  mono?: boolean
  /**
   * 0–1. Draws an inline bar beneath the row, sized to this fraction of the
   * group's largest. Supplying it is a claim that the rows are comparable —
   * counts on one scale, or shares of one whole. Mixed units must not.
   */
  fraction?: number
  /** Tailwind class for the bar's fill, when the default track hue is wrong. */
  barClassName?: string
}

export function KeyValueGroup({
  title,
  description,
  entries,
  children,
  className,
}: {
  title?: ReactNode
  /** One line under the heading. Anything longer belongs behind `Why`. */
  description?: ReactNode
  entries?: KeyValueEntry[]
  /** `KeyValueRow`s, for a group whose rows are not uniform data. */
  children?: ReactNode
  className?: string
}) {
  // Normalised against the group's own maximum rather than against 1: a
  // per-channel count of 8.1 million against a 0-1 axis is a full bar beside
  // five invisible ones, which says less than the numbers did.
  const peak = Math.max(0, ...(entries ?? []).map((entry) => entry.fraction ?? 0))

  return (
    <div data-density-group className={cn('min-w-0', className)}>
      {title ? <p className="label-caps mb-0.5">{title}</p> : null}
      {description ? (
        <p className="text-muted-foreground mb-1 text-2xs leading-snug">{description}</p>
      ) : null}
      <dl className="divide-border/60 divide-y">
        {(entries ?? []).map(({ id, fraction, ...row }) => (
          <KeyValueRow
            key={id}
            {...row}
            fraction={fraction === undefined ? undefined : peak > 0 ? fraction / peak : 0}
          />
        ))}
        {children}
      </dl>
    </div>
  )
}

/**
 * One row. Same shape as `DataRow` — stacked below sm so a value that wraps is
 * not right-aligned ragged prose — with the bar as an extra full-width line so
 * it never competes with the number for the row's horizontal space.
 */
export function KeyValueRow({
  label,
  value,
  hint,
  mono = false,
  fraction,
  barClassName = 'bg-track',
  className,
}: Omit<KeyValueEntry, 'id'> & { className?: string }) {
  return (
    <div data-density-row className={cn('py-2', className)}>
      <div
        className={cn(
          'flex flex-col items-start gap-0.5',
          'sm:flex-row sm:items-baseline sm:justify-between sm:gap-4',
        )}
      >
        <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
        <dd
          className={cn(
            'min-w-0 text-left text-xs sm:text-right',
            mono ? 'font-mono break-all' : 'tnum break-words',
          )}
        >
          {value === EMPTY ? (
            <span className="text-muted-foreground/70">
              <span aria-hidden>{EMPTY}</span>
              <span className="sr-only">not reported</span>
            </span>
          ) : (
            value
          )}
          {hint ? (
            <span className="text-muted-foreground mt-0.5 block font-sans text-2xs font-normal">
              {hint}
            </span>
          ) : null}
        </dd>
      </div>
      {fraction === undefined ? null : (
        // Hidden from assistive technology, deliberately. The bar carries no
        // fact the row has not already stated, and it is drawn against the
        // group's own peak rather than against 100% — announced as a meter it
        // would read out a second, differently-scaled number for one value.
        <div aria-hidden className="mt-1.5">
          <BarMeter
            role="img"
            aria-label=""
            fraction={fraction}
            fillClassName={barClassName}
            className="h-1"
          />
        </div>
      )}
    </div>
  )
}
