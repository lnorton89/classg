/**
 * A media query, as React state.
 *
 * Used where a layout has to be a DIFFERENT TREE rather than different
 * classes, which is rare and worth being deliberate about: CSS is the right
 * tool almost every time, and swapping trees unmounts everything inside them.
 *
 * The live map is the case that needs it. Its wide layout is a resizable
 * group and its narrow one is a stack of two panes; expressing that with
 * classes means rendering the map twice and letting CSS hide one, which is two
 * MapLibre instances and two WebGL contexts on a Pi's browser to display one
 * map.
 */
import { useSyncExternalStore } from 'react'

/** Unsubscribe for an environment that can never emit a change. */
const noop = (): void => undefined

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      // jsdom and any environment without matchMedia: never changes, so the
      // unsubscribe has nothing to undo.
      if (typeof globalThis.matchMedia !== 'function') return noop
      const list = globalThis.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () =>
      typeof globalThis.matchMedia === 'function'
        ? globalThis.matchMedia(query).matches
        : false,
    // Server snapshot: narrow. There is no server render here, but the hook
    // should not claim a width it cannot measure.
    () => false,
  )
}

/** The `lg` breakpoint, which is where this app's layouts change shape. */
export const LG_QUERY = '(min-width: 64rem)'
