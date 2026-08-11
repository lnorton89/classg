import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, XCircleIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('bg-muted animate-pulse rounded-md', className)}
      aria-hidden
      {...props}
    />
  )
}

export function Separator({ className, ...props }: ComponentProps<'div'>) {
  return <div role="separator" className={cn('bg-border h-px w-full', className)} {...props} />
}

const ALERT_ICONS = {
  info: InfoIcon,
  ok: CheckCircle2Icon,
  warn: AlertTriangleIcon,
  error: XCircleIcon,
} as const

export interface AlertProps {
  tone?: keyof typeof ALERT_ICONS
  title: ReactNode
  children?: ReactNode
  className?: string
  action?: ReactNode
}

export function Alert({ tone = 'info', title, children, className, action }: AlertProps) {
  const Icon = ALERT_ICONS[tone]
  const toneClass = {
    info: 'border-border bg-muted/40 text-foreground',
    ok: 'border-ok/40 bg-ok/10 text-foreground',
    warn: 'border-warn/40 bg-warn/10 text-foreground',
    error: 'border-down/45 bg-down/10 text-foreground',
  }[tone]
  const iconClass = {
    info: 'text-muted-foreground',
    ok: 'text-ok',
    warn: 'text-warn',
    error: 'text-down',
  }[tone]

  return (
    <div
      // `alert` interrupts a screen reader. Reserved for the two tones that
      // mean the operator must act; info and success are announced politely by
      // the surrounding live region, or not at all.
      role={tone === 'warn' || tone === 'error' ? 'alert' : undefined}
      className={cn('flex items-start gap-3 rounded-lg border p-3', toneClass, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug font-semibold">{title}</p>
        {children ? (
          <div className="text-muted-foreground mt-1 text-xs leading-relaxed">{children}</div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** Label + value pair. Used everywhere in detail views. */
export function DataRow({
  label,
  value,
  mono = false,
  className,
}: {
  label: ReactNode
  value: ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 py-1', className)}>
      <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
      <dd className={cn('min-w-0 text-right text-xs break-all', mono && 'font-mono')}>
        {value}
      </dd>
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon?: typeof InfoIcon
  title: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-col items-center justify-center gap-2 p-8 text-center',
        className,
      )}
    >
      {Icon ? <Icon className="size-6 opacity-60" aria-hidden /> : null}
      <p className="text-foreground text-sm font-medium">{title}</p>
      {children ? <div className="max-w-sm text-xs">{children}</div> : null}
    </div>
  )
}
