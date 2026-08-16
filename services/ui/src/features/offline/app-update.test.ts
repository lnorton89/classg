import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AppUpdateWatcher,
  type ContainerLike,
  type RegistrationLike,
  type UpdateStatus,
  type WorkerLike,
} from './app-update'

class FakeWorker implements WorkerLike {
  state = 'installing'
  readonly posted: unknown[] = []
  private readonly listeners = new Set<() => void>()

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  addEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.delete(listener)
  }

  transitionTo(state: string): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeRegistration implements RegistrationLike {
  waiting: WorkerLike | null = null
  installing: WorkerLike | null = null
  updateCalls = 0
  updateRejects = false
  private readonly listeners = new Set<() => void>()

  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.delete(listener)
  }

  update(): Promise<unknown> {
    this.updateCalls += 1
    return this.updateRejects ? Promise.reject(new Error('offline')) : Promise.resolve()
  }

  /** A new worker starts downloading. */
  beginInstall(worker: FakeWorker): void {
    this.installing = worker
    for (const listener of [...this.listeners]) listener()
  }

  /** …and finishes, which is when the browser moves it to `waiting`. */
  finishInstall(worker: FakeWorker): void {
    this.installing = null
    this.waiting = worker
    worker.transitionTo('installed')
  }
}

class FakeContainer implements ContainerLike {
  controller: unknown = { id: 'the worker already serving this page' }
  private readonly listeners = new Set<() => void>()

  addEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.delete(listener)
  }

  /** What the browser does once a waiting worker calls skipWaiting + claim. */
  swapController(): void {
    this.controller = { id: 'the new worker' }
    for (const listener of [...this.listeners]) listener()
  }
}

interface Harness {
  registration: FakeRegistration
  container: FakeContainer
  watcher: AppUpdateWatcher
  reload: ReturnType<typeof vi.fn>
  seen: UpdateStatus[]
}

function harness(options: { controlled?: boolean; pollMs?: number } = {}): Harness {
  const registration = new FakeRegistration()
  const container = new FakeContainer()
  if (options.controlled === false) container.controller = null
  const reload = vi.fn()
  const seen: UpdateStatus[] = []

  const watcher = new AppUpdateWatcher({
    registration,
    container,
    reload,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  })
  watcher.subscribe((status) => seen.push(status))

  return { registration, container, watcher, reload, seen }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('AppUpdateWatcher', () => {
  it('offers an update that installed while the page was open', () => {
    const h = harness()
    h.watcher.start()
    expect(h.watcher.getStatus()).toBe('idle')

    const next = new FakeWorker()
    h.registration.beginInstall(next)
    expect(h.watcher.getStatus()).toBe('idle')

    h.registration.finishInstall(next)
    expect(h.watcher.getStatus()).toBe('available')
    expect(h.seen).toEqual(['available'])
  })

  it('offers an update that was already waiting when the page loaded', () => {
    const h = harness()
    const waiting = new FakeWorker()
    waiting.state = 'installed'
    h.registration.waiting = waiting

    h.watcher.start()
    expect(h.watcher.getStatus()).toBe('available')
  })

  /*
   * The first install is not an update. The worker calls clientsClaim(), so
   * without this guard a brand new visitor is told a newer build is ready
   * seconds after their first ever page load.
   */
  it('stays idle on a first install, when nothing controls the page yet', () => {
    const h = harness({ controlled: false })
    h.watcher.start()

    const first = new FakeWorker()
    h.registration.beginInstall(first)
    h.registration.finishInstall(first)

    expect(h.watcher.getStatus()).toBe('idle')
    expect(h.seen).toEqual([])
  })

  it('does not reload on a controller change it did not ask for', () => {
    const h = harness({ controlled: false })
    h.watcher.start()
    h.container.swapController()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('asks the waiting worker to take over, then reloads once it has', () => {
    const h = harness()
    const next = new FakeWorker()
    h.watcher.start()
    h.registration.beginInstall(next)
    h.registration.finishInstall(next)

    h.watcher.applyUpdate()
    expect(next.posted).toEqual([{ type: 'SKIP_WAITING' }])
    expect(h.watcher.getStatus()).toBe('applying')
    // Not yet: the page must not reload before the new worker is serving it.
    expect(h.reload).not.toHaveBeenCalled()

    h.container.swapController()
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('ignores applyUpdate when nothing is waiting', () => {
    const h = harness()
    h.watcher.start()
    h.watcher.applyUpdate()
    expect(h.watcher.getStatus()).toBe('idle')
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('polls for a new build, because a single-page console never navigates', () => {
    const h = harness({ pollMs: 60_000 })
    h.watcher.start()
    expect(h.registration.updateCalls).toBe(0)

    vi.advanceTimersByTime(180_000)
    expect(h.registration.updateCalls).toBe(3)
  })

  it('swallows a failed update check — the unit being down is not news', async () => {
    const h = harness({ pollMs: 1_000 })
    h.registration.updateRejects = true
    h.watcher.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.registration.updateCalls).toBe(1)
    expect(h.watcher.getStatus()).toBe('idle')
  })

  it('stops polling and listening once stopped', () => {
    const h = harness({ pollMs: 1_000 })
    h.watcher.start()
    h.watcher.stop()

    vi.advanceTimersByTime(10_000)
    expect(h.registration.updateCalls).toBe(0)

    const next = new FakeWorker()
    h.registration.beginInstall(next)
    h.registration.finishInstall(next)
    expect(h.watcher.getStatus()).toBe('idle')
  })

  it('reports each status change once', () => {
    const h = harness()
    const next = new FakeWorker()
    h.watcher.start()
    h.registration.beginInstall(next)
    h.registration.finishInstall(next)
    // A second `updatefound` for an already-installed worker must not re-notify.
    h.registration.beginInstall(next)

    h.watcher.applyUpdate()
    expect(h.seen).toEqual(['available', 'applying'])
  })
})
