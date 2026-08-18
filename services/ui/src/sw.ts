/// <reference lib="webworker" />
/**
 * ClassG service worker.
 *
 * Compiled by vite-plugin-pwa in `injectManifest` mode: the plugin replaces
 * `self.__WB_MANIFEST` with the hashed build output and bundles this file to
 * `dist/sw.js`. Registration is in `src/features/offline/register-sw.ts`, and is
 * deliberately not injected by the plugin — see that file for the three gates.
 *
 * ## The one rule
 *
 * **Detections, tracks, health and every other API response are never cached.**
 *
 * A service worker's whole trick is answering from cache when the network is
 * gone, and that trick is a lie in this application. ADR-0003 and the sky-state
 * banner exist because an empty map with a dead sensor must not look like an
 * empty map with a healthy one; a cache that replayed yesterday's tracks after
 * the Pi went down would defeat both, and it would do it invisibly — the page
 * would look exactly as it does when everything works. So `/api/**` is
 * NetworkOnly, deliberately and permanently. When the API is unreachable the
 * fetch fails, TanStack Query reports the error, and the UI says so
 * (the header `StatusButton`, `computeSkyState`, and the offline banner in
 * `src/features/offline/`). That is the honest failure, and it is the one the
 * rest of the interface was built to render.
 *
 * What *is* cached is the part that carries no claim about the sky:
 *
 *   - the app shell (HTML, JS, CSS, fonts, icons) — precached, so the console
 *     opens instantly on the Pi's AP and still opens when the Pi is off. An
 *     empty console that says "offline" is useful; a blank tab is not.
 *   - satellite basemap tiles — imagery of the ground, which does not change
 *     between now and the last time you flew.
 */
import { clientsClaim } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkOnly } from 'workbox-strategies'

import { isCacheableTileResponse } from './features/offline/tile-cache'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | PrecacheEntry)[]
}

/** Matches nginx.conf and the Vite dev proxy. All three must agree. */
const SATELLITE_TILE = /^\/tiles\/basemap\/\d+\/\d+\/\d+\.jpg$/

// ---------------------------------------------------------------------------
// Precache: the app shell
// ---------------------------------------------------------------------------

precacheAndRoute(self.__WB_MANIFEST)

// Drops precaches written by earlier Workbox revisions. Without it a Pi that
// has run several builds accumulates one full copy of the bundle per deploy in
// a storage budget shared with the tile cache.
cleanupOutdatedCaches()

// ---------------------------------------------------------------------------
// Runtime routes, most specific first — Workbox takes the first match.
// ---------------------------------------------------------------------------

/*
 * The API. NetworkOnly is what a request does with no service worker at all, so
 * registering this route changes no behaviour today; it is here to make the
 * policy explicit and to make it survive. Any future catch-all — a
 * StaleWhileRevalidate added for "offline support", a broad NavigationRoute —
 * would otherwise start answering /api/v1/tracks from cache, and nothing in the
 * UI would look wrong. This route is the thing that keeps that from compiling
 * quietly.
 *
 * WS /stream needs no rule: a service worker cannot intercept a WebSocket
 * handshake, so the live stream is always the real thing or nothing.
 */
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly())

/*
 * The pmtiles archives are read with HTTP range requests. Caching a 206 as if
 * it were the whole file is a well-known way to corrupt a vector basemap, and
 * caching the whole file means a 46 MB entry, so: never.
 */
registerRoute(({ url }) => url.pathname.endsWith('.pmtiles'), new NetworkOnly())

/*
 * Satellite imagery. Cache-first because a tile of the ground is immutable for
 * our purposes, and because on the Pi every miss is a proxied round trip to
 * Esri that only succeeds when the unit has an uplink at all.
 *
 * The `cacheWillUpdate` guard is the important part — see `tile-cache.ts` for
 * what it is refusing and why a 200 is not enough to trust here.
 */
registerRoute(
  ({ url }) => SATELLITE_TILE.test(url.pathname),
  new CacheFirst({
    cacheName: 'classg-satellite-tiles',
    plugins: [
      {
        cacheWillUpdate: ({ response }) =>
          Promise.resolve(isCacheableTileResponse(response) ? response : null),
      },
      new ExpirationPlugin({
        // ~2000 tiles is a few square kilometres at the zooms an operator
        // actually flies at, and comfortably under a typical origin quota
        // alongside the precached bundle.
        maxEntries: 2000,
        maxAgeSeconds: 180 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  }),
)

/*
 * SPA navigations. `/tracks/abc` is not a file on disk — nginx rewrites it to
 * index.html — so offline it has to come from the precached shell or the route
 * simply does not exist once the network is gone.
 */
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/tiles\//],
  }),
)

// ---------------------------------------------------------------------------
// Update handshake
// ---------------------------------------------------------------------------

/*
 * `skipWaiting` only on request. A worker that skipped waiting on its own would
 * swap the bundle under a live console mid-session — new JS against a page
 * rendered by the old one — so the new build sits in `waiting` until the
 * operator accepts the prompt raised by `AppUpdateWatcher`.
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data: unknown = event.data
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'SKIP_WAITING'
  ) {
    void self.skipWaiting()
  }
})

// Paired with skipWaiting: claiming is what fires `controllerchange` in the
// open page, which is the signal register-sw.ts reloads on.
clientsClaim()
