/**
 * The standard page heading.
 *
 * Every route had rolled its own `<h1>` + paragraph, which meant five slightly
 * different sizes and no consistent place for page-level actions. One
 * component: brand-tinted icon, title in the display face, a one-line
 * explanation, and a right-aligned action slot.
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export interface PageHeaderProps {
  icon: LucideIcon
  title: string
  description?: ReactNode
  /** Buttons, filters, or status. Wraps under the title on narrow screens. */
  actions?: ReactNode
  className?: string
}

export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start gap-x-4 gap-y-3', className)}>
      <span
        className={cn(
          'border-primary/25 bg-primary/10 text-primary flex size-10 shrink-0',
          'items-center justify-center rounded-lg border',
        )}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-xl leading-tight font-bold">{title}</h1>
        {description ? (
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** Section heading inside a page. Same idea, one level down. */
export function SectionHeader({
  icon: Icon,
  title,
  description,
  actions,
  id,
  className,
}: PageHeaderProps & { id?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start gap-x-3 gap-y-2', className)}>
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <h2 id={id} className="font-display text-base leading-tight font-semibold">
          {title}
        </h2>
        {description ? (
          <p className="text-muted-foreground mt-0.5 max-w-3xl text-xs leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
