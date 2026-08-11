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
import type { ClientFrame, ServerFrame } from './types'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface LiveStreamOptions {
  url: string
  topics?: ('tracks' | 'health' | 'detections')[]
  /** Injectable for tests. */
  socketFactory?: (url: string) => WebSocket
  /** First retry delay in ms. Doubles per attempt up to `maxDelayMs`. */
  baseDelayMs?: number
  maxDelayMs?: number
  /** Full jitter avoids a thundering herd when the Pi reboots. 0 disables it. */
  jitter?: () => number
}

const DEFAULT_TOPICS: ('tracks' | 'health' | 'detections')[] = [
  'tracks',
  'health',
  'detections',
]

type FrameListener = (frame: ServerFrame) => void
type StateListener = (state: ConnectionState) => void
/** Fired on every successful (re)connection, including the first. */
type ConnectListener = (info: { isReconnect: boolean }) => void

export class LiveStream {
  private readonly url: string
  private readonly topics: ('tracks' | 'health' | 'detections')[]
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
export function streamUrl(apiBase: string, origin = globalThis.location?.origin ?? ''): string {
  if (/^wss?:\/\//.test(apiBase)) return `${apiBase.replace(/\/$/, '')}/stream`
  const absolute = /^https?:\/\//.test(apiBase)
    ? apiBase
    : `${origin.replace(/\/$/, '')}${apiBase}`
  return `${absolute.replace(/^http/, 'ws').replace(/\/$/, '')}/stream`
}
