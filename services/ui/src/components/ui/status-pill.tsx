/**
 * The one status vocabulary.
 *
 * Six components had independently invented "how a state looks": the header
 * kept its own tone maps, `Badge` carried ok/warn/down variants, the watchdog
 * and deploy panels reached for whichever of those was nearest, and the
 * recording indicator had a third shape again. They mostly agreed, which is
 * worse than disagreeing — an operator learns that a colour means something
 * and then meets the one place it does not.
 *
 * The tones themselves, and why there are exactly five of them, live in
 * status-pill-variants.ts.
 *
 * `Badge` still exists for label chips — an event name, a vendor, "SSO". Its
 * health variants were removed so a status cannot drift back onto it.
 */
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { statusPill } from '@/components/ui/status-pill-variants'
import { cn } from '@/lib/cn'

export type StatusPillProps = ComponentProps<'span'> &
  VariantProps<typeof statusPill> & {
    /** Leading dot in the pill's own colour. */
    dot?: boolean
    /**
     * Pulse the dot. Only for a live, currently-true state — a pulse on a
     * healthy unit is an alarm that is always on, which is an alarm nobody
     * reads.
     */
    pulse?: boolean
  }

export function StatusPill({
  className,
  tone,
  size,
  interactive,
  dot = false,
  pulse = false,
  children,
  ...props
}: StatusPillProps) {
  return (
    <span className={cn(statusPill({ tone, size, interactive }), className)} {...props}>
      {dot ? (
        <span
          aria-hidden
          className={cn(
            // `bg-current` inherits the tone's own colour, so the dot can
            // never drift out of step with the pill around it.
            'size-1.5 shrink-0 rounded-full bg-current',
            pulse && 'animate-pulse motion-reduce:animate-none',
          )}
        />
      ) : null}
      {children}
    </span>
  )
}
