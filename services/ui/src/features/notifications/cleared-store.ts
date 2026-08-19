/**
 * Cleared notification ids, for the drawer's per-row swipe/clear control.
 *
 * Unlike sky-state's dismissal (one current value per group, see
 * dismissal-store.ts), a drawer can have any number of rows cleared
 * independently, so this holds a set rather than a single value. Reactive
 * (subscribe/getSnapshot), matching logStore: the drawer and every row it
 * renders need to see a clear the instant it happens, not just on their next
 * mount, since rows come and go under the same drawer instance as the feed
 * repolls.
 *
 * Session-scoped like the dismissal store, for the same reason: it survives
 * navigation and the app's own self-reload, and clears when the tab actually
 * closes -- an "already seen and cleared" list that outlives the operator's
 * session forever would eventually hide a genuinely new event that happens to
 * reuse an id, which cannot happen for log entries (ids are per-session
 * already) but is worth not assuming for track ids too.
 */
const STORAGE_KEY = 'classg.notifications.cleared'
/**
 * The feed itself is capped at 200 rows (see RENDER_LIMIT in
 * notifications-drawer.tsx) -- an id that has scrolled out of that window can
 * never be looked up again. This just needs to comfortably outlast one
 * drawer's worth of clearing, not grow without bound over a long session.
 */
const MAX_STORED = 500

class ClearedStore {
  private ids: Set<string>
  private listeners = new Set<() => void>()

  constructor() {
    this.ids = readStored()
  }

  has = (id: string): boolean => this.ids.has(id)

  getSnapshot = (): Set<string> => this.ids

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clear(id: string): void {
    if (this.ids.has(id)) return
    const next = new Set(this.ids)
    next.add(id)
    this.ids = trim(next)
    persist(this.ids)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Drops the oldest-inserted entries first -- `Set` preserves insertion order. */
function trim(ids: Set<string>): Set<string> {
  if (ids.size <= MAX_STORED) return ids
  const next = new Set(ids)
  const overflow = next.size - MAX_STORED
  let dropped = 0
  for (const id of next) {
    if (dropped >= overflow) break
    next.delete(id)
    dropped += 1
  }
  return next
}

function readStored(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    return new Set()
  }
}

function persist(ids: Set<string>): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Storage can be unavailable in privacy modes; clearing still applies for this mount.
  }
}

export const clearedNotifications = new ClearedStore()
