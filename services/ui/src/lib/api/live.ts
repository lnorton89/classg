/**
 * WebSocket client for `WS /stream`.
 *
 * The contract's requirement, restated because it is the whole reason this file
 * is not thirty lines:
 *
 *   "Clients reconnect with exponential backoff and refetch GET /tracks on
 *    reconnect — the stream carries no history and gaps must not silently
 *    persist."
 *
 * So the socket is not just a transport, it is a *freshness* signal. Anything
 * that reads live data must also know when the connection dropped, because a
 * stale track list rendered confidently is exactly the failure this project
 * exists to avoid.
 */
import type { ClientFrame, ServerFrame, StreamTopic } from './types'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface LiveStreamOptions {
  url: string
  topics?: LiveTopic[]
  /** Injectable for tests. */
  socketFactory?: (url: string) => WebSocket
  /** First retry delay in ms. Doubles per attempt up to `maxDelayMs`. */
  baseDelayMs?: number
  maxDelayMs?: number
  /** Full jitter avoids a thundering herd when the Pi reboots. 0 disables it. */
  jitter?: () => number
}

export type LiveTopic = StreamTopic

/**
 * Everything the console renders live.
 *
 * `captures` and `spectrum` were missing, and the effect was subtle enough to
 * survive a long time: the server filters frames by subscription, so
 * capture.status frames were dropped at the hub and the client-side handler
 * for them was dead code. A running capture only advanced when a query happened
 * to refetch, and a finished sweep never updated the page that started it.
 */
const DEFAULT_TOPICS: LiveTopic[] = ['tracks', 'health', 'detections', 'captures', 'spectrum']

type FrameListener = (frame: ServerFrame) => void
type StateListener = (state: ConnectionState) => void
/** Fired on every successful (re)connection, including the first. */
type ConnectListener = (info: { isReconnect: boolean }) => void

export class LiveStream {
  private readonly url: string
  private readonly topics: LiveTopic[]
  private readonly socketFactory: (url: string) => WebSocket
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitter: () => number

  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private everConnected = false
  private stopped = false
  private state: ConnectionState = 'closed'

  private readonly frameListeners = new Set<FrameListener>()
  private readonly stateListeners = new Set<StateListener>()
  private readonly connectListeners = new Set<ConnectListener>()

  constructor(options: LiveStreamOptions) {
    this.url = options.url
    this.topics = options.topics ?? DEFAULT_TOPICS
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url))
    this.baseDelayMs = options.baseDelayMs ?? 500
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.jitter = options.jitter ?? Math.random
  }

  getState(): ConnectionState {
    return this.state
  }

  /** Attempt number of the pending reconnect; 0 when connected. */
  getAttempt(): number {
    return this.attempt
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onConnect(listener: ConnectListener): () => void {
    this.connectListeners.add(listener)
    return () => this.connectListeners.delete(listener)
  }

  connect(): void {
    this.stopped = false
    this.open()
  }

  close(): void {
    this.stopped = true
    this.clearTimer()
    if (this.socket) {
      // Drop handlers first so a close we asked for doesn't schedule a retry.
      this.detach(this.socket)
      this.socket.close()
      this.socket = null
    }
    this.setState('closed')
  }

  /**
   * Retry now, from a clean slate, because the reason for backing off has gone.
   *
   * Backoff assumes the far end is unwell and that waiting helps. That is wrong
   * for the case this exists to fix: a phone browser suspends a backgrounded
   * tab, the socket dies, and the retries that follow are frozen along with the
   * page. The user returns to a console holding minutes-old tracks, and the
   * pending timer may still be up to `maxDelayMs` from firing. Nothing was
   * wrong with the server; the client was asleep.
   *
   * Resetting `attempt` matters as much as the immediate open: without it a
   * long suspension leaves the backoff at its 30s ceiling, so the NEXT blip
   * after resume also takes half a minute to recover.
   *
   * Safe to call often. An already-open socket is left alone, so a burst of
   * visibility and online events costs nothing.
   */
  resume(): void {
    if (this.stopped) return
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.socket?.readyState === WebSocket.CONNECTING) return
    this.clearTimer()
    this.attempt = 0
    this.open()
  }

  send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame))
    }
  }

  /**
   * Delay before retry `attempt` (1-indexed), with full jitter:
   *   random(0, min(base * 2^(attempt-1), max))
   */
  delayFor(attempt: number): number {
    const ceiling = Math.min(this.baseDelayMs * 2 ** Math.max(0, attempt - 1), this.maxDelayMs)
    return Math.floor(this.jitter() * ceiling)
  }

  // -------------------------------------------------------------------------

  private open(): void {
    if (this.stopped) return
    this.setState(this.everConnected ? 'reconnecting' : 'connecting')

    let socket: WebSocket
    try {
      socket = this.socketFactory(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      const isReconnect = this.everConnected
      this.everConnected = true
      this.attempt = 0
      this.setState('open')
      this.send({ type: 'subscribe', topics: this.topics })
      // Consumers refetch here. Do it AFTER subscribing so any state change that
      // lands between the refetch and the subscription is still delivered.
      for (const listener of this.connectListeners) listener({ isReconnect })
    }

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      let frame: ServerFrame
      try {
        frame = JSON.parse(event.data) as ServerFrame
      } catch {
        return
      }
      if (frame.type === 'ping') {
        this.send({ type: 'pong' })
        return
      }
      for (const listener of this.frameListeners) listener(frame)
    }

    socket.onerror = () => {
      // `close` always follows; retry is scheduled there so it happens once.
    }

    socket.onclose = () => {
      this.socket = null
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.attempt += 1
    this.setState('reconnecting')
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, this.delayFor(this.attempt))
  }

  private detach(socket: WebSocket): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.stateListeners) listener(state)
  }
}

/** Resolve the stream URL from the API base, honouring http→ws / https→wss. */
export function streamUrl(
  apiBase: string,
  // The DOM types say `location` is always there. It is not in Node, which is
  // where the tests for this function run.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  origin = globalThis.location?.origin ?? '',
): string {
  if (/^wss?:\/\//.test(apiBase)) return `${apiBase.replace(/\/$/, '')}/stream`
  const absolute = /^https?:\/\//.test(apiBase)
    ? apiBase
    : `${origin.replace(/\/$/, '')}${apiBase}`
  return `${absolute.replace(/^http/, 'ws').replace(/\/$/, '')}/stream`
}
