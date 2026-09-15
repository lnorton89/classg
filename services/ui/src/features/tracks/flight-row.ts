/**
 * Finding a flight's row in whichever list is on screen.
 *
 * Its own module rather than an export from `flights-table.tsx`, for the Fast
 * Refresh rule this codebase already follows elsewhere: a file that exports
 * both components and plain functions loses hot reload for everything in it.
 *
 * A DOM query rather than a ref, because the row that exists is whichever
 * layout is rendered — the table above `lg`, the card below it — and the caller
 * is a band of time that has no business knowing which. Both carry the
 * attribute, and scrolling one inside a `display:none` subtree does nothing, so
 * there is no need to work out which is which.
 */

/** The attribute both layouts stamp, and the only thing the lookup depends on. */
export const FLIGHT_ROW_ATTR = 'data-flight-id'

/** Bring a flight's row into view, if this build has one on screen. */
export function scrollFlightIntoView(trackId: string): void {
  if (typeof document === 'undefined') return
  const selector = `[${FLIGHT_ROW_ATTR}="${CSS.escape(trackId)}"]`
  for (const node of document.querySelectorAll(selector)) {
    // jsdom has no layout and therefore no scrollIntoView; a test that selects
    // a bar should assert the selection, not fall over on the scroll.
    if (node instanceof HTMLElement && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' })
    }
  }
}
