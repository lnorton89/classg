import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The Timeline became a view of Flights.
 *
 * It had always been the Flights page's question — what happened over this
 * period — answered over a second copy of the Flights page's state, and the two
 * drifted: picking a day on the list and coming here landed on "the last 24
 * hours", having quietly lost the day. `/tracks?view=lanes` is the same band
 * over the list's own window and filters.
 *
 * Kept as a redirect rather than deleted, like `/config` before it: this URL is
 * in the operator guide and in browser bookmarks, and a 404 on a page somebody
 * reaches for mid-watch is a worse outcome than a route file that renders
 * nothing. The route also has to keep existing for `routeTree.gen.ts` to stay
 * valid without a regeneration.
 */
export const Route = createFileRoute('/timeline')({
  beforeLoad: () => {
    // TanStack signals a redirect by throwing a plain object, not an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/tracks', search: { view: 'lanes' } })
  },
})
