/**
 * Reconnect behaviour, and specifically `resume()`.
 *
 * The bug this covers: a phone suspends a backgrounded tab, the socket closes,
 * the retry timer freezes with the page, and the console comes back holding
 * minutes-old tracks. Backoff is right when the server is unwell and wrong when
 * the client was merely asleep, so returning to the tab has to retry now AND
 * reset the delay — otherwise the next blip after resume waits the full 30s
 * ceiling as well.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LiveStream } from './live'

/** Minimal stand-in: enough surface for the stream to drive and inspect. */
class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  open() {
    this.readyState = 1 // OPEN
    this.onopen?.()
  }

  drop() {
    this.readyState = 3 // CLOSED
    this.onclose?.()
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }
}

function makeStream() {
  FakeSocket.instances = []
  const stream = new LiveStream({
    url: 'ws://test/stream',
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitter: () => 1, // full delay, no randomness, so timings are exact
  })
  return stream
}

beforeEach(() => {
  vi.useFakeTimers()
})

describe('LiveStream.resume', () => {
  it('reconnects immediately instead of waiting out the backoff', () => {
    const stream = makeStream()
    stream.connect()
    FakeSocket.instances[0]?.open()
    FakeSocket.instances[0]?.drop()

    expect(FakeSocket.instances).toHaveLength(1)

    // Without resume the retry is a full second away; resume must not wait.
    stream.resume()
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('resets the backoff so the next drop recovers fast too', () => {
    const stream = makeStream()
    stream.connect()
    FakeSocket.instances[0]?.open()

    // Three failed retries walk the delay up to 4x base.
    FakeSocket.instances[0]?.drop()
    vi.advanceTimersByTime(1000)
    FakeSocket.instances[1]?.drop()
    vi.advanceTimersByTime(2000)
    FakeSocket.instances[2]?.drop()
    expect(stream.getAttempt()).toBeGreaterThan(1)

    stream.resume()
    expect(stream.getAttempt()).toBe(0)
    expect(stream.delayFor(1)).toBe(1000)
  })

  it('leaves an already-open socket alone', () => {
    const stream = makeStream()
    stream.connect()
    FakeSocket.instances[0]?.open()

    stream.resume()
    stream.resume()

    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('does not open a second socket while one is still connecting', () => {
    const stream = makeStream()
    stream.connect()
    // Never opened: still CONNECTING.
    stream.resume()
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('stays closed after close() — resume must not revive a stopped stream', () => {
    const stream = makeStream()
    stream.connect()
    FakeSocket.instances[0]?.open()
    stream.close()

    stream.resume()

    expect(FakeSocket.instances).toHaveLength(1)
    expect(stream.getState()).toBe('closed')
  })

  it('does not leave the old retry timer armed after resuming', () => {
    const stream = makeStream()
    stream.connect()
    FakeSocket.instances[0]?.open()
    FakeSocket.instances[0]?.drop()

    stream.resume()
    expect(FakeSocket.instances).toHaveLength(2)

    // If the superseded timer were still armed it would fire here and open a
    // third socket behind the one resume just made.
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
