/**
 * Service worker registration.
 *
 * Deliberately not injected by vite-plugin-pwa: three things have to be true
 * before ClassG may install a worker, and two of them are specific to how this
 * unit is deployed.
 *
 *   1. Production only. In dev, MSW owns a service worker at the same scope
 *      (`public/mockServiceWorker.js`) and only one worker can control a page —
 *      registering ours would silently unhook every mocked endpoint, which
 *      looks like "the dev server lost its API" rather than like a conflict.
 *   2. A secure context. See below; this is the one that bites in the field.
 *   3. The browser has service workers at all.
 *
 * Every rejection is written to the event log rather than swallowed. A console
 * that quietly is not a PWA, on a unit whose whole point is that degradation is
 * visible, would be the wrong kind of silence — and the log is where an
 * operator already goes to find out why something is not doing what they
 * expected.
 */
import { log } from '@/features/logs/log-store'

import { AppUpdateWatcher } from './app-update'

/** Emitted by vite-plugin-pwa's injectManifest build from `src/sw.ts`. */
const SW_URL = '/sw.js'

let pending: Promise<AppUpdateWatcher | null> | null = null

/**
 * Register once per page load and hand back the update watcher.
 *
 * Resolves to null whenever ClassG is running without a worker, which is a
 * supported state: nothing in the app depends on the cache existing. The
 * console then behaves exactly as it did before this feature — every request
 * goes to the network, and the offline banner still tells the truth, because it
 * reads the live stream rather than the cache.
 */
export function registerAppServiceWorker(): Promise<AppUpdateWatcher | null> {
  pending ??= register()
  return pending
}

async function register(): Promise<AppUpdateWatcher | null> {
  if (!import.meta.env.PROD) return null

  if (!('serviceWorker' in navigator)) {
    log.warn('ui', 'Offline support unavailable: this browser has no service worker support.')
    return null
  }

  /*
   * The one that bites. Service workers require a secure context, and the Pi
   * serves this console over plain HTTP on the LAN — so `http://localhost:8080`
   * on the Pi itself qualifies (localhost is treated as secure) while
   * `http://classg.local:8080` or `http://192.168.x.x:8080` from a phone does
   * not. On that phone there is no install prompt, no precache and no offline
   * mode, and the browser gives no visible reason for it.
   *
   * Saying so in the log is the least this can do. Fixing it is a deployment
   * decision that does not belong in the bundle: terminate TLS in front of
   * nginx, or reach the unit over a network that already does (Tailscale hands
   * out real certificates for *.ts.net, which is the cheapest route on a Pi
   * with no public DNS).
   */
  if (!globalThis.isSecureContext) {
    log.warn(
      'ui',
      'Offline support and install unavailable: this page is not a secure context.',
      {
        origin: globalThis.location.origin,
        reason: 'Service workers require HTTPS, or a localhost origin.',
      },
    )
    return null
  }

  let registration: ServiceWorkerRegistration
  try {
    registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' })
  } catch (error) {
    log.error(
      'ui',
      `Service worker registration failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }

  const watcher = new AppUpdateWatcher({
    registration,
    container: navigator.serviceWorker,
  })
  watcher.start()

  // The browser checks for a new worker on navigation, and a single-page app
  // left open on a bench does not navigate. Checking when the operator comes
  // back to it is the moment they are most likely to accept a reload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') watcher.checkNow()
  })

  log.info('ui', 'Offline support active: the console shell is cached on this device.')
  return watcher
}
