/**
 * A modal popup, centered over the page with a backdrop.
 *
 * Thin wrapper over Base UI, in the house style of popover.tsx: one component,
 * the project's tokens, and no options nobody uses. Unlike the popover, this is
 * genuinely modal -- a backdrop dims the page and swallows the first click, and
 * Base UI traps focus inside while it is open. That is the right trade for a
 * task someone opened on purpose and needs to finish or dismiss (sharing,
 * confirming), not for a glanceable panel like the notifications drawer.
 *
 * The header and footer are fixed; only the body between them scrolls. A share
 * card or a long form should never push the close button or the primary action
 * off the bottom of a phone screen.
 */
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { XIcon } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/cn'

import { buttonVariants } from './button-variants'

export interface DialogProps {
  /**
   * The control. Base UI merges its own props onto this element rather than
   * wrapping it, so it must be a single element and it must carry its own
   * accessible name.
   */
  trigger: ReactElement
  children: ReactNode
  /** Rendered in the header. Required -- every dialog needs an accessible name. */
  title: string
  description?: string
  /** Pinned below the scrollable body, e.g. the primary and secondary actions. */
  footer?: ReactNode
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Dialog({
  trigger,
  children,
  title,
  description,
  footer,
  className,
  open,
  onOpenChange,
}: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Trigger render={trigger} />
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={cn(
            'fixed inset-0 z-50 bg-black/50',
            'transition-opacity duration-100',
            'data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
          )}
        />
        <BaseDialog.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'bg-popover text-popover-foreground border-border flex flex-col overflow-hidden',
            'rounded-lg border shadow-2xl',
            'max-h-[calc(100dvh-2rem)] w-[min(24rem,calc(100vw-2rem))]',
            // Explicit and short for the same reason as popover.tsx: a panel
            // mid-fade shows its text mixed with the page's, so that state
            // must be too brief to catch.
            'transition-[transform,opacity] duration-100',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            className,
          )}
        >
          <header className="border-border bg-muted flex shrink-0 items-start justify-between gap-2 border-b-2 px-4 py-3">
            <div className="min-w-0">
              <BaseDialog.Title className="font-display text-base leading-tight font-bold tracking-tight">
                {title}
              </BaseDialog.Title>
              {description ? (
                <BaseDialog.Description className="text-muted-foreground mt-1 text-2xs leading-snug">
                  {description}
                </BaseDialog.Description>
              ) : null}
            </div>
            <BaseDialog.Close
              aria-label="Close"
              className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'shrink-0')}
            >
              <XIcon className="size-4" aria-hidden />
            </BaseDialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

          {footer ? (
            <footer className="border-border bg-card shrink-0 border-t px-4 py-3">
              {footer}
            </footer>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
