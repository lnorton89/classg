import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, XCircleIcon, XIcon } from 'lucide-react'
import { useEffect } from 'react'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { EMPTY } from '@/lib/format'

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
  /**
   * Called when the operator closes it. Supplying this adds the close control;
   * omitting it means the banner cannot be dismissed.
   *
   * Deliberately opt-in, and NOT available on warn or error. A banner that
   * says the sky is unwatched has to stay on the screen for as long as it is
   * true -- letting somebody clear a degraded-sensor warning is the one thing
   * this whole interface is built to refuse, because an empty map with a dead
   * sensor must never be able to look like an empty map with a healthy one.
   * `autoDismissMs` is subject to the same rule.
   */
  onDismiss?: () => void
  /**
   * Close on its own after this many milliseconds. Only honoured alongside
   * onDismiss, and only on the tones that are safe to lose.
   */
  autoDismissMs?: number
}

export function Alert({
  tone = 'info',
  title,
  children,
  className,
  action,
  onDismiss,
  autoDismissMs,
}: AlertProps) {
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

  // The rule, enforced here rather than trusted to every caller: only a tone
  // that carries good or neutral news can be closed or timed out.
  const dismissible = onDismiss !== undefined && tone !== 'warn' && tone !== 'error'
  const timeout = dismissible ? autoDismissMs : undefined

  useEffect(() => {
    if (timeout === undefined || timeout <= 0 || !onDismiss) return
    const id = setTimeout(onDismiss, timeout)
    return () => clearTimeout(id)
  }, [timeout, onDismiss])

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
      {dismissible ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this message"
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-foreground/10',
            '-my-1 -mr-1 shrink-0 rounded-md p-1 transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  )
}

/**
 * A `<dl>` of `DataRow`s, optionally under a section label.
 *
 * The rules between rows are the point: a label on the left and its value on
 * the right are separated by a gap wide enough that the eye loses the pairing
 * once a list passes about five rows. Grouping under a label keeps any one run
 * shorter than that.
 */
export function DataList({
  label,
  className,
  children,
}: {
  label?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {label ? <p className="label-caps mb-0.5">{label}</p> : null}
      <dl className="divide-border/60 divide-y">{children}</dl>
    </div>
  )
}

/**
 * Label + value pair. Used everywhere in detail views.
 *
 * A missing reading is dimmed and announced as "not reported"; left as a bare
 * em dash a screen reader either says "em dash" or nothing at all, and neither
 * conveys that the field exists but was never broadcast.
 */
export function DataRow({
  label,
  value,
  hint,
  mono = false,
  className,
}: {
  label: ReactNode
  value: ReactNode
  /** Secondary line under the value — an age, a unit note, a caveat. */
  hint?: ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <div
      // The first consumer of the compact-density preference on a detail page:
      // 0.5rem here, 0.375rem when the operator asks for compact.
      data-density-row
      className={cn(
        // Stacked below sm, label-and-value across from sm up.
        //
        // Right-aligned prose that wraps looks broken, and on a phone almost
        // everything wraps: a commit subject under "Running 9a234ae9" came out
        // as two ragged right-aligned lines that read as a layout fault. A
        // label above its value has room to be either short or long.
        'flex flex-col items-start gap-0.5 py-2',
        'sm:flex-row sm:items-baseline sm:justify-between sm:gap-4',
        className,
      )}
    >
      <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-left text-xs sm:text-right',
          // Identifiers may break anywhere; prose must not.
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
