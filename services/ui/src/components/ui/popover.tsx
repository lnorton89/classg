/**
 * A panel anchored to the control that opened it.
 *
 * Thin wrapper over Base UI, in the house style of select.tsx and tooltip.tsx:
 * one component, the project's tokens, and no options nobody uses.
 *
 * The width behaviour is the part worth knowing. On a phone the panel is
 * pinned to the viewport with a margin rather than sized from its anchor -- a
 * popover anchored to a 36px icon button at the right edge of a 360px screen
 * either overflows or wraps into a column two words wide. `--available-width`
 * is Base UI's measurement of the room actually left on screen.
 */
import { Popover as BasePopover } from '@base-ui/react/popover'
import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/cn'

export interface PopoverProps {
  /**
   * The control. Base UI merges its own props onto this element rather than
   * wrapping it, so it must be a single element and it must carry its own
   * accessible name.
   */
  trigger: ReactElement
  children: ReactNode
  /** Accessible name for the panel itself. */
  'aria-label': string
  className?: string
  align?: 'start' | 'center' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Popover({
  trigger,
  children,
  className,
  align = 'end',
  open,
  onOpenChange,
  'aria-label': ariaLabel,
}: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          side="bottom"
          align={align}
          sideOffset={8}
          // Keeps the panel off the screen edge on a phone, where the trigger
          // is nearly at it.
          collisionPadding={8}
          className="z-50"
        >
          <BasePopover.Popup
            aria-label={ariaLabel}
            className={cn(
              'bg-popover text-popover-foreground border-border rounded-lg border shadow-lg',
              'w-[min(20rem,var(--available-width))] overflow-hidden',
              'origin-(--transform-origin) transition-[transform,opacity]',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              className,
            )}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
