/**
 * "A new build is on the Pi — do you want it?"
 *
 * A precached console is a pinned one: once a service worker is serving the
 * shell from cache, a deploy on the Pi changes nothing on the phone until the
 * worker itself is replaced. Left alone, an operator can run a build from three
 * releases ago for weeks and have no way to know — the failure this file exists
 * to prevent.
 *
 * The other half of the trade is that the update must not apply itself.
 * `skipWaiting()` on install would swap the bundle under a live console: the
 * page keeps its old JS in memory while every subsequent chunk request is
 * served from the new precache, which is how you get a lazy route that fails to
 * import halfway through a session. So the new worker waits, this raises a
 * prompt, and the operator picks the moment.
 *
 * Written against structural interfaces rather than `navigator.serviceWorker`
 * so the state machine can be tested with fakes, the same way `LiveStream`
 * takes an injectable socket factory. The registration wiring is in
 * `register-sw.ts`; nothing here touches a global.
 */

export type UpdateStatus =
  /** Nothing waiting. */
  | 'idle'
  /** A new build is installed and waiting for permission to take over. */
  | 'available'
  /** The operator accepted; the swap and reload are in flight. */
  | 'applying'

export interface WorkerLike {
  state: string
  postMessage(message: unknown): void
  addEventListener(type: 'statechange', listener: () => void): void
  removeEventListener(type: 'statechange', listener: () => void): void
}

export interface RegistrationLike {
  waiting: WorkerLike | null
  installing: WorkerLike | null
  addEventListener(type: 'updatefound', listener: () => void): void
  removeEventListener(type: 'updatefound', listener: () => void): void
  update(): Promise<unknown>
}

export interface ContainerLike {
  /** Null until a worker controls this page — i.e. before the first install. */
  controller: unknown
  addEventListener(type: 'controllerchange', listener: () => void): void
  removeEventListener(type: 'controllerchange', listener: () => void): void
}

export interface AppUpdateWatcherOptions {
  registration: RegistrationLike
  container: ContainerLike
  /**
   * How often to ask the server whether a newer worker exists. Browsers check
   * on navigation, and this console is a single-page app that an operator
   * leaves open — on a wall, on a phone in a pocket — for days without one.
   * Without a poll, "deploy and tell them to refresh" is the update mechanism.
   */
  pollMs?: number
  reload?: () => void
}

type Listener = (status: UpdateStatus) => void

// Five minutes, not thirty. This unit deploys itself from main whenever CI
// goes green, so a build can land at any time and half an hour of running the
// previous one is half an hour of debugging a fix that is definitely in the
// repo and definitely not on the screen. The check is one conditional request
// for the worker script, usually over the Pi's own access point.
const DEFAULT_POLL_MS = 5 * 60 * 1000

export class AppUpdateWatcher {
  private readonly registration: RegistrationLike
  private readonly container: ContainerLike
  private readonly pollMs: number
  private readonly reload: () => void

  private status: UpdateStatus = 'idle'
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  /** Guards the reload: see `onControllerChange`. */
  private applying = false
  private watched: WorkerLike | null = null

  private readonly listeners = new Set<Listener>()

  private readonly onUpdateFound = () => {
    this.watchInstalling()
  }

  private readonly onInstalledStateChange = () => {
    const worker = this.watched
    if (!worker) return
    if (worker.state === 'installed') this.offerIfSuperseding()
    // 'redundant' means the install failed or was replaced by a newer one.
    if (worker.state === 'redundant') this.unwatch()
  }

  private readonly onControllerChange = () => {
    // Only reload for a swap this watcher asked for. The worker calls
    // `clientsClaim()`, so on a FIRST install the controller changes moments
    // after the page loads with no update involved at all — reloading there
    // would be a spontaneous refresh a second into every new operator's first
    // visit, and on a slow first install, a loop.
    if (this.applying) this.reload()
  }

  constructor(options: AppUpdateWatcherOptions) {
    this.registration = options.registration
    this.container = options.container
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.reload = options.reload ?? (() => globalThis.location.reload())
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.started) return
    this.started = true

    this.registration.addEventListener('updatefound', this.onUpdateFound)
    this.container.addEventListener('controllerchange', this.onControllerChange)

    // A worker can already be waiting when the page loads — the operator
    // opened the console, closed it before accepting, and came back.
    if (this.registration.waiting) this.offerIfSuperseding()
    // Or an install can be in flight from a previous tab.
    else if (this.registration.installing) this.watchInstalling()

    this.timer = setInterval(() => {
      this.checkNow()
    }, this.pollMs)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.registration.removeEventListener('updatefound', this.onUpdateFound)
    this.container.removeEventListener('controllerchange', this.onControllerChange)
    this.unwatch()
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Ask the server for a newer worker now. Safe to call at any time. */
  checkNow(): void {
    void this.registration.update().catch(() => {
      // Offline, or the Pi is down. The poll will come round again; a failed
      // update check is not something to report to an operator.
    })
  }

  /**
   * Accept the waiting build. Tells it to take over; the reload follows from
   * the resulting `controllerchange`, not from here, so the page is never
   * reloaded before the new worker is actually in charge of serving it.
   */
  applyUpdate(): void {
    const waiting = this.registration.waiting
    if (this.status !== 'available' || !waiting) return
    this.applying = true
    this.setStatus('applying')
    waiting.postMessage({ type: 'SKIP_WAITING' })
  }

  // -------------------------------------------------------------------------

  private watchInstalling(): void {
    const worker = this.registration.installing
    if (!worker) return
    this.unwatch()
    this.watched = worker
    if (worker.state === 'installed') this.offerIfSuperseding()
    else worker.addEventListener('statechange', this.onInstalledStateChange)
  }

  private unwatch(): void {
    this.watched?.removeEventListener('statechange', this.onInstalledStateChange)
    this.watched = null
  }

  /**
   * An installed worker is only an *update* if something was already serving
   * this page. On a first visit the same event means "offline support is now
   * ready", which is not a reason to ask anybody to reload.
   */
  private offerIfSuperseding(): void {
    if (this.container.controller === null || this.container.controller === undefined) return
    this.setStatus('available')
  }

  private setStatus(status: UpdateStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.listeners) listener(status)
  }
}
