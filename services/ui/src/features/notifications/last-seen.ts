/**
 * The bell's read watermark: everything after it is "new".
 *
 * It used to fall back to 0 when nothing was stored, which means the beginning
 * of time — so a fresh browser opened the console to a bell reading 10 unread,
 * every one of them a flight that happened before anybody sat down. A badge
 * that is never zero is a badge nobody reads, which is the opposite of what it
 * is for: the number has to mean "arrived since you last looked", and on a
 * first visit the honest answer is none.
 *
 * Its own module rather than two functions at the foot of the drawer, for the
 * same reason `cleared-store.ts` is: the rule is about time and storage, and
 * it is worth being able to state it without rendering a panel.
 */
const STORAGE_KEY = 'classg.notifications.lastSeenAt'

/**
 * Seeded on this browser's first visit, and written immediately rather than
 * left to the first drawer open — otherwise a reload before anyone touches the
 * bell starts the count over from the beginning of the buffer again.
 */
export function readLastSeen(now: number = Date.now()): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw !== null) return Number(raw) || 0
    writeLastSeen(now)
    return now
  } catch {
    // Private browsing and similar. Counting from this moment is still the
    // right answer; it just cannot be remembered past the reload.
    return now
  }
}

export function writeLastSeen(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    /* ignore */
  }
}
