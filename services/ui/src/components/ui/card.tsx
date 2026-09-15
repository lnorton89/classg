import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * How much of the page this card is asking for.
 *
 * Every card weighed the same, which is the same as no card weighing anything:
 * a page of six identical boxes makes the operator decide what matters, on
 * every visit, from scratch. Three weights, and the rule that goes with them —
 * **at most one `primary` per page**, the thing the page exists for.
 *
 *   primary    lifted off the ground with a brand-tinted ring
 *   secondary  the current bordered card
 *   plain      no border and no ground; a section under its own heading
 *
 * Omitting `weight` keeps exactly today's appearance, so a page that has not
 * been through the hierarchy pass is unchanged rather than silently demoted.
 */
export type CardWeight = 'primary' | 'secondary' | 'plain'

const WEIGHT: Record<CardWeight, string> = {
  primary: 'bg-card text-card-foreground border-primary/25 rounded-lg border shadow-md',
  secondary: 'bg-card text-card-foreground border-border rounded-lg border shadow-xs',
  // Not `border-0` alone: `@layer base` applies `border-border` to everything,
  // so the border has to be removed by width. The child rule is the other half
  // of "no card" — a section with no border but still inset 1rem from the page
  // edge reads as a card someone forgot to draw.
  plain:
    'text-card-foreground rounded-lg border-0 bg-transparent shadow-none [&>[data-card-section]]:px-0',
}

export function Card({
  className,
  weight,
  ...props
}: ComponentProps<'div'> & { weight?: CardWeight }) {
  return (
    <div
      className={cn(WEIGHT[weight ?? 'secondary'], className)}
      data-card-weight={weight}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-card-section
      className={cn('flex flex-col gap-1 p-4 pb-2', className)}
      {...props}
    />
  )
}

export function CardTitle({
  className,
  children,
  ...props
}: ComponentProps<'h3'> & { children: ReactNode }) {
  return (
    <h3 className={cn('text-sm font-semibold tracking-tight', className)} {...props}>
      {children}
    </h3>
  )
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-muted-foreground text-xs', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-card-section className={cn('p-4 pt-2', className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-card-section
      className={cn('flex items-center gap-2 p-4 pt-0', className)}
      {...props}
    />
  )
}
