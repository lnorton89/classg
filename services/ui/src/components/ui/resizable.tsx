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
 */
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export { Panel }

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
  return (
    <Separator
      className={cn(
        'group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center',
        'outline-none focus-visible:ring-ring focus-visible:ring-2',
        className,
      )}
    >
      <div className="bg-border group-hover:bg-primary h-full w-px transition-colors" />
      <div
        aria-hidden
        className={cn(
          'bg-border group-hover:bg-primary absolute h-8 w-1 rounded-full',
          'opacity-0 transition-opacity group-hover:opacity-100',
        )}
      />
    </Separator>
  )
}

export function ResizableSplit({
  id,
  children,
  className,
}: {
  /** Storage key. Stable across builds, or the remembered split is lost. */
  id: string
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
    <Group
      id={id}
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className={cn('flex min-h-0 flex-1', className)}
    >
      {children}
    </Group>
  )
}
