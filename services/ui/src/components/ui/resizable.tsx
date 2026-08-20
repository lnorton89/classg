/**
 * Draggable splits, for the places an operator genuinely trades space.
 *
 * Wraps react-resizable-panels in the house style, and adds the two things a
 * console needs that the library leaves to the caller.
 *
 * **The split is remembered per browser.** A wall-mounted display and a laptop
 * want different splits, and re-dragging on every page load is the kind of
 * small tax that makes somebody stop bothering. The library's useDefaultLayout
 * handles the storage; this supplies a safe one.
 *
 * **It only exists where there is room.** Below the breakpoint the panes stack
 * and no group is rendered at all: dragging a divider on a phone means making
 * one of two things too small to read, through a target a few pixels wide.
 * The narrow layout is a tab switch, which is what it should be.
 *
 * Both orientations are supported, and the same rule governs both: a divider is
 * only worth having between two panes that are each independently scrollable
 * and bounded by the viewport. In a page that scrolls as one document there is
 * nothing to trade, which is why every route except the live map is untouched.
 */
import { createContext, use } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export { Panel }

export type SplitOrientation = 'horizontal' | 'vertical'

/**
 * The handle has to know which way it is being dragged -- cursor, hit area, and
 * the direction the grip runs all flip -- and making that a prop means every
 * caller can get it wrong independently of the group it sits in. Reading it
 * from the group removes the chance.
 */
const OrientationContext = createContext<SplitOrientation>('horizontal')

/**
 * localStorage, or nothing at all.
 *
 * The group writes on every drag, and a browser with storage disabled --
 * private mode, a locked-down kiosk -- throws on the write rather than
 * returning false. An unremembered split is a small loss; a console that
 * crashes when somebody drags a divider is not.
 */
const panelStorage = {
  getItem(name: string): string | null {
    try {
      return window.localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem(name: string, value: string): void {
    try {
      window.localStorage.setItem(name, value)
    } catch {
      // Ignored on purpose. See above.
    }
  },
}

/**
 * The handle: a 1px rule that becomes a visible grip on hover.
 *
 * The hit area is much larger than the line, because a divider fat enough to
 * grab comfortably is a divider running down the middle of the map. Keyboard
 * resizing comes from the library; the focus ring is what makes it findable.
 */
export function ResizeHandle({ className }: { className?: string }) {
  const orientation = use(OrientationContext)
  const vertical = orientation === 'vertical'

  return (
    <Separator
      className={cn(
        'group relative flex shrink-0 items-center justify-center',
        vertical ? 'h-2 w-full cursor-row-resize' : 'w-2 cursor-col-resize',
        'outline-none focus-visible:ring-ring focus-visible:ring-2',
        className,
      )}
    >
      <div
        className={cn(
          'bg-border group-hover:bg-primary transition-colors',
          vertical ? 'h-px w-full' : 'h-full w-px',
        )}
      />
      <div
        aria-hidden
        className={cn(
          'bg-border group-hover:bg-primary absolute rounded-full',
          vertical ? 'h-1 w-8' : 'h-8 w-1',
          'opacity-0 transition-opacity group-hover:opacity-100',
        )}
      />
    </Separator>
  )
}

export function ResizableSplit({
  id,
  orientation = 'horizontal',
  children,
  className,
}: {
  /** Storage key. Stable across builds, or the remembered split is lost. */
  id: string
  /** Which way the panes sit. Horizontal is side by side, vertical is stacked. */
  orientation?: SplitOrientation
  children: ReactNode
  className?: string
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id,
    storage: panelStorage,
    // Only what somebody dragged. A window resize rewriting the stored split
    // means rotating a tablet permanently changes the layout you chose.
    onlySaveAfterUserInteractions: true,
  })

  return (
    <OrientationContext value={orientation}>
      <Group
        id={id}
        orientation={orientation}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        // No flex-direction here on purpose: the group sets its own inline,
        // from the orientation above, and an inline style wins over a class.
        // A `flex-col` in this list would look like it were doing the work.
        className={cn('flex min-h-0 flex-1', className)}
      >
        {children}
      </Group>
    </OrientationContext>
  )
}
