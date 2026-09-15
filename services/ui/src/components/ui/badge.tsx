import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/cn'

/**
 * A label chip: an event name, an action, "SSO", "you".
 *
 * Deliberately has no health tones. It used to carry ok/warn/down alongside
 * `StatusPill`, and having two primitives that could both say "degraded" is
 * how the app ended up with six subtly different reds. Anything that reports
 * a *state* belongs in `StatusPill` (status-pill.tsx), which owns that
 * vocabulary; removing the variants here is what keeps it owning it — a
 * status written against this component now fails to typecheck.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-border bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
