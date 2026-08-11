/**
 * The session event log.
 *
 * What this is: a client-side record of everything the console observed while
 * it was open — stream connects and drops, track lifecycle, sensor health
 * transitions, capture activity, API failures, and operator actions.
 *
 * What this is NOT: the system's log. The sensors and the API write their own
 * logs on the Pi, and those are the authority for anything forensic. This one
 * starts empty when the page loads and lives only in memory. It exists because
 * the question it answers — "what just happened, and in what order?" — is
 * otherwise unanswerable from a UI that only ever shows current state. A track
 * that appeared and closed while you were looking at the sensors page leaves no
 * trace anywhere else in this interface.
 *
 * Design constraints that shaped it:
 *
 *   - Bounded. This runs on a 4 GB Pi in a browser tab that may be open for
 *     days. The buffer is a fixed-size ring; old entries are dropped, and the
 *     UI says so rather than pretending it has everything.
 *   - Coalesced. Detections arrive continuously. Notifying React per entry
 *     would re-render the log view hundreds of times a second, so appends are
 *     batched and flushed on a timer.
 *   - Transitions, not samples. A confirmed drone beacons at ~1 Hz; logging
 *     every `track.update` would bury the one line that matters. Only changes
 *     of state are recorded.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/** Ordering for "this level and above" filtering. */
export const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export type LogSource = 'stream' | 'track' | 'detection' | 'sensor' | 'capture' | 'api' | 'ui'

export const LOG_SOURCES: LogSource[] = [
  'stream',
  'track',
  'detection',
  'sensor',
  'capture',
  'api',
  'ui',
]

export interface LogEntry {
  /** Monotonic within the session. Also the React key and the sort order. */
  id: number
  at: string
  level: LogLevel
  source: LogSource
  message: string
  /** Structured context. Rendered as chips and preserved verbatim in exports. */
  detail?: Record<string, string | number | boolean | null | undefined>
  /** When present, the entry links to that track's detail page. */
  trackId?: string
}

export type LogInput = Omit<LogEntry, 'id' | 'at'> & { at?: string }

const DEFAULT_LIMIT = 1000
const FLUSH_MS = 250

/**
 * Debug entries are the ones that can arrive in a burst, and they are also the
 * ones nobody is reading in real time. Cap them so a noisy RF environment
 * cannot evict every interesting line from the buffer in one second.
 */
const DEBUG_BURST_LIMIT = 12
const DEBUG_BURST_WINDOW_MS = 1000

class LogStore {
  private entries: LogEntry[] = []
  private pending: LogEntry[] = []
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private limit = DEFAULT_LIMIT
  private dropped = 0
  private debugWindowStart = 0
  private debugWindowCount = 0
  private suppressedDebug = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): LogEntry[] => this.entries

  /** Entries discarded because the buffer is full, for the "showing N of…" line. */
  getDropped = (): number => this.dropped

  setLimit(limit: number): void {
    this.limit = Math.max(50, Math.min(10_000, limit))
    if (this.entries.length > this.limit) {
      this.dropped += this.entries.length - this.limit
      this.entries = this.entries.slice(-this.limit)
      this.emit()
    }
  }

  append(input: LogInput): void {
    if (input.level === 'debug' && this.isDebugThrottled()) {
      this.suppressedDebug += 1
      return
    }
    if (this.suppressedDebug > 0 && input.level !== 'debug') {
      // Surface the gap rather than leaving a silent hole in the record.
      const suppressed = this.suppressedDebug
      this.suppressedDebug = 0
      this.push({
        level: 'debug',
        source: 'ui',
        message: `${suppressed} further detection ${
          suppressed === 1 ? 'entry' : 'entries'
        } not logged (rate limit)`,
      })
    }
    this.push(input)
  }

  clear(): void {
    this.entries = []
    this.pending = []
    this.dropped = 0
    this.emit()
  }

  private push(input: LogInput): void {
    this.pending.push({
      ...input,
      id: this.nextId++,
      at: input.at ?? new Date().toISOString(),
    })
    this.schedule()
  }

  private isDebugThrottled(): boolean {
    const now = Date.now()
    if (now - this.debugWindowStart > DEBUG_BURST_WINDOW_MS) {
      this.debugWindowStart = now
      this.debugWindowCount = 0
    }
    this.debugWindowCount += 1
    return this.debugWindowCount > DEBUG_BURST_LIMIT
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_MS)
  }

  private flush(): void {
    if (this.pending.length === 0) return
    const merged = this.entries.concat(this.pending)
    this.pending = []
    if (merged.length > this.limit) {
      this.dropped += merged.length - this.limit
      this.entries = merged.slice(-this.limit)
    } else {
      this.entries = merged
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const logStore = new LogStore()

/** Convenience wrappers. `log.ui(...)` reads better at a call site than an object. */
export const log = {
  debug: (source: LogSource, message: string, detail?: LogEntry['detail']) =>
    logStore.append({ level: 'debug', source, message, ...(detail ? { detail } : {}) }),
  info: (source: LogSource, message: string, detail?: LogEntry['detail']) =>
    logStore.append({ level: 'info', source, message, ...(detail ? { detail } : {}) }),
  warn: (source: LogSource, message: string, detail?: LogEntry['detail']) =>
    logStore.append({ level: 'warn', source, message, ...(detail ? { detail } : {}) }),
  error: (source: LogSource, message: string, detail?: LogEntry['detail']) =>
    logStore.append({ level: 'error', source, message, ...(detail ? { detail } : {}) }),
  /** Operator actions: what was clicked, and what the system said back. */
  action: (message: string, detail?: LogEntry['detail']) =>
    logStore.append({ level: 'info', source: 'ui', message, ...(detail ? { detail } : {}) }),
  entry: (input: LogInput) => logStore.append(input),
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** NDJSON: one self-contained JSON object per line, greppable and appendable. */
export function toNdjson(entries: LogEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n')
}

export function toCsv(entries: LogEntry[]): string {
  const escape = (text: string): string =>
    /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  const header = 'timestamp,level,source,message,track_id,detail'
  const rows = entries.map((entry) =>
    [
      entry.at,
      entry.level,
      entry.source,
      escape(entry.message),
      entry.trackId ?? '',
      escape(entry.detail ? JSON.stringify(entry.detail) : ''),
    ].join(','),
  )
  return [header, ...rows].join('\n')
}

export function downloadText(filename: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
