/**
 * The one cache decision in the service worker that can be got wrong quietly.
 *
 * Lives outside `sw.ts` so it can be unit-tested: the worker itself is excluded
 * from the app's TypeScript project (worker scope, not window scope) and cannot
 * be imported by a test, and this predicate is the part with a right answer
 * rather than a policy.
 *
 * The trap it guards is in `services/ui/nginx.conf`. When nginx cannot reach
 * the upstream imagery it answers `@empty_tile` — an empty GIF at **HTTP 200**,
 * not a 404, so that the map degrades to blank squares instead of erroring.
 * That is correct for a proxy and poison for a cache-first strategy: stored
 * once, the blank tile becomes the permanent answer for that coordinate, and
 * the hole survives the uplink coming back. The map would then be missing
 * imagery for reasons no longer present anywhere in the system.
 *
 * nginx labels the fallback twice, and either label is enough to refuse it.
 */

/** Set by nginx's `@empty_tile` location on the placeholder GIF. */
const OFFLINE_FALLBACK_HEADER = 'X-ClassG-Basemap'
const OFFLINE_FALLBACK_VALUE = 'offline fallback'

export function isCacheableTileResponse(response: Response): boolean {
  // 200 only. A 206 is a range response, which this route never asks for, and
  // an opaque cross-origin response reports 0 with no way to tell a tile from
  // an error page.
  if (response.status !== 200) return false
  if (response.headers.get(OFFLINE_FALLBACK_HEADER) === OFFLINE_FALLBACK_VALUE) return false
  // The general form of the same statement, honoured for any origin that says
  // it — a future tile source need not know about our header to opt out.
  return !(response.headers.get('Cache-Control') ?? '').includes('no-store')
}
