import { cn } from '@/lib/cn'

/**
 * A track with a fill sized to a fraction of it — the shell under a
 * confidence bar, a disk-usage bar, a channel-share bar. The domain meaning
 * and the color policy stay with the caller; this owns only the DOM and the
 * ARIA wiring.
 *
 * `role="meter"` (the default) is for a value with a known scale that means
 * something on its own, and carries `aria-valuenow`/min/max. Pass
 * `role="img"` instead for a bar that only makes sense paired with a label
 * naming what it shows, the way the disk-usage figure already reads
 * "Used 62%" beside it.
 */
export function BarMeter({
  fraction,
  className,
  fillClassName = 'bg-track',
  role = 'meter',
  'aria-label': ariaLabel,
}: {
  fraction: number
  className?: string
  fillClassName?: string
  role?: 'meter' | 'img'
  'aria-label': string
}) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100)

  return (
    <span
      role={role}
      aria-valuenow={role === 'meter' ? pct : undefined}
      aria-valuemin={role === 'meter' ? 0 : undefined}
      aria-valuemax={role === 'meter' ? 100 : undefined}
      aria-label={ariaLabel}
      className={cn('bg-muted relative block overflow-hidden rounded-full', className)}
    >
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full', fillClassName)}
        style={{ width: `${pct}%` }}
      />
    </span>
  )
}
