/**
 * Transient confirmations.
 *
 * Scope rule, worth stating because toasts are so easy to over-use: a toast is
 * for an action the operator just took whose result is otherwise invisible —
 * "settings saved", "restart accepted", "copied". It is never used for anything
 * about the sky or the sensors. Detection state and coverage failures go to
 * persistent, on-screen surfaces (the sky-state banner, the status pills, the
 * event log) because a message that disappears after five seconds is exactly
 * the wrong carrier for "you are no longer watching the airspace".
 */
import { Toast } from '@base-ui/react/toast'
import { CheckCircle2Icon, InfoIcon, TriangleAlertIcon, XIcon, XCircleIcon } from 'lucide-react'

import { cn } from '@/lib/cn'

export const ToastProvider = Toast.Provider
export const useToast = Toast.useToastManager

export type ToastTone = 'success' | 'error' | 'warn' | 'info'

const TONE_ICON = {
  success: CheckCircle2Icon,
  error: XCircleIcon,
  warn: TriangleAlertIcon,
  info: InfoIcon,
} as const

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'text-ok',
  error: 'text-down',
  warn: 'text-warn',
  info: 'text-primary',
}

function isTone(value: string | undefined): value is ToastTone {
  return value === 'success' || value === 'error' || value === 'warn' || value === 'info'
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <Toast.Portal>
      <Toast.Viewport
        className={cn(
          'fixed right-2 bottom-20 z-50 mx-auto flex w-[min(22rem,calc(100vw-1rem))]',
          // bottom-20 on mobile clears the fixed bottom nav; on desktop the nav
          // lives in the header, so the toast can sit at the true bottom.
          'md:bottom-3',
        )}
      >
        {toasts.map((toast) => {
          const tone: ToastTone = isTone(toast.type) ? toast.type : 'info'
          const Icon = TONE_ICON[tone]
          return (
            <Toast.Root
              key={toast.id}
              toast={toast}
              className={cn(
                'bg-popover text-popover-foreground border-border absolute right-0 bottom-0 w-full',
                'flex items-start gap-2.5 rounded-lg border p-3 shadow-lg',
                'transition-all duration-200',
                'data-starting-style:translate-y-2 data-starting-style:opacity-0',
                'data-ending-style:translate-y-2 data-ending-style:opacity-0',
              )}
              // Toasts are absolutely positioned on top of each other; Base UI
              // exposes each one's depth as `--toast-index`. Offsetting and
              // shrinking by it turns the pile into a legible stack without
              // measuring anything.
              style={{
                transform:
                  'translateY(calc(var(--toast-index) * -0.75rem)) scale(calc(1 - var(--toast-index) * 0.04))',
              }}
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', TONE_CLASS[tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <Toast.Title className="text-sm leading-snug font-medium" />
                <Toast.Description className="text-muted-foreground mt-0.5 text-xs leading-snug" />
              </div>
              <Toast.Close
                aria-label="Dismiss"
                className="text-muted-foreground hover:text-foreground -mt-0.5 -mr-0.5 rounded p-1"
              >
                <XIcon className="size-3.5" aria-hidden />
              </Toast.Close>
            </Toast.Root>
          )
        })}
      </Toast.Viewport>
    </Toast.Portal>
  )
}
