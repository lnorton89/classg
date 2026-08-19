import { useCallback, useRef } from 'react'

/**
 * Arrow-key navigation for a popover that is genuinely a MENU.
 *
 * Tab alone is a legal way to move through a list of links and buttons, which
 * is why this was survivable without it -- but a control that looks like a menu
 * and announces itself as one is expected to answer arrow keys, and the command
 * palette already sets that expectation elsewhere in this app.
 *
 * Deliberately not applied to every popover: the status panel is a disclosure
 * with one link in a wall of text, and calling that a menu would announce
 * "menu, 1 item" over content that is mostly prose.
 *
 * Focus is moved directly rather than through a roving tabindex, because the
 * items are real <a>/<button> elements that are already tabbable and already
 * carry the app's focus ring. Home/End are included because a menu whose last
 * item is "Sign out" is exactly where someone wants to jump.
 */
export function useMenuKeys() {
  const ref = useRef<HTMLDivElement | null>(null)

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key)) return

    const container = ref.current
    if (!container) return

    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
    )
    if (items.length === 0) return

    // The active element may be the trigger rather than an item (the panel has
    // just opened), in which case index is -1 and ArrowDown lands on the first.
    const index = items.indexOf(document.activeElement as HTMLElement)

    let next: number
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length
    else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length

    // Only now: an unhandled arrow key should still scroll the panel.
    event.preventDefault()
    items[next]?.focus()
  }, [])

  // A tuple, not an object: react-hooks/refs reads `menu.ref` in JSX as
  // touching a ref during render. Destructured at the call site it is a plain
  // identifier, which is what the rule is actually asking for.
  return [ref, onKeyDown] as const
}
