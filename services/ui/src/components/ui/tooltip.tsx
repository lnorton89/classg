import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

/**
 * Tooltips are supplementary here, never the only carrier of information: they
 * do not exist on touch, so anything essential is also in visible text or an
 * accessible name.
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={<span className="inline-flex" />}>
        {children}
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        {/*
          The z-index belongs on the Positioner, not the Popup. Base UI gives
          the Positioner a transform, which creates a stacking context — so a
          z-index on the Popup inside it is scoped to that context and cannot
          clear the z-40 app header. See the layer list in styles.css.
        */}
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup
            className={cn(
              'bg-popover text-popover-foreground border-border max-w-72 rounded-md border',
              'px-2.5 py-1.5 text-xs shadow-md',
              'origin-(--transform-origin) transition-[transform,opacity] duration-100',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              className,
            )}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
