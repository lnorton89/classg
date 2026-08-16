import { describe, expect, it } from 'vitest'

import {
  ATTEMPTS_BEFORE_ANNOUNCING,
  computeFreshness,
  STALE_AFTER_MS,
  type FreshnessInput,
} from './freshness'

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

function input(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    online: true,
    connection: 'open',
    reconnectAttempt: 0,
    lastUpdateAt: NOW - 1_000,
    now: NOW,
    ...overrides,
  }
}

describe('computeFreshness', () => {
  it('is live and silent while the stream is connected', () => {
    const result = computeFreshness(input())
    expect(result.level).toBe('live')
    expect(result.announce).toBe(false)
    expect(result.ageMs).toBe(1_000)
  })

  /*
   * The requirement this module exists for: a precached console opens whether
   * or not the unit is reachable, so "offline" must never be inferable only
   * from an empty map.
   */
  it('announces offline even when the stream last reported as open', () => {
    const result = computeFreshness(input({ online: false }))
    expect(result.level).toBe('offline')
    expect(result.announce).toBe(true)
  })

  it('states the age of what is on screen when offline', () => {
    const result = computeFreshness(input({ online: false, lastUpdateAt: NOW - 125_000 }))
    expect(result.ageMs).toBe(125_000)
    expect(result.detail).toContain('2m 5s')
    expect(result.detail).toContain('frozen')
  })

  it('does not imply an age when nothing was ever received', () => {
    const result = computeFreshness(input({ online: false, lastUpdateAt: null }))
    expect(result.ageMs).toBeNull()
    expect(result.detail).not.toMatch(/\d+[smhd]/)
    // The distinction the whole architecture turns on.
    expect(result.detail).toContain('not because nothing is flying')
  })

  it('stays quiet through a short reconnect', () => {
    const result = computeFreshness(
      input({ connection: 'reconnecting', lastUpdateAt: NOW - 5_000 }),
    )
    expect(result.level).toBe('reconnecting')
    expect(result.announce).toBe(false)
  })

  it('announces once the data outlives the staleness threshold', () => {
    const result = computeFreshness(
      input({ connection: 'reconnecting', lastUpdateAt: NOW - STALE_AFTER_MS }),
    )
    expect(result.level).toBe('stale')
    expect(result.announce).toBe(true)
    expect(result.detail).toContain('frozen')
  })

  it('honours a caller-supplied threshold', () => {
    const at = input({ connection: 'closed', lastUpdateAt: NOW - 4_000 })
    expect(computeFreshness({ ...at, staleAfterMs: 10_000 }).level).toBe('reconnecting')
    expect(computeFreshness({ ...at, staleAfterMs: 2_000 }).level).toBe('stale')
  })

  it('says nothing during the very first connection attempt', () => {
    const result = computeFreshness(
      input({ connection: 'connecting', reconnectAttempt: 0, lastUpdateAt: null }),
    )
    expect(result.level).toBe('reconnecting')
    expect(result.announce).toBe(false)
  })

  it('announces a repeatedly failed first connection as "not a reading"', () => {
    const result = computeFreshness(
      input({
        connection: 'reconnecting',
        reconnectAttempt: ATTEMPTS_BEFORE_ANNOUNCING,
        lastUpdateAt: null,
      }),
    )
    expect(result.level).toBe('stale')
    expect(result.announce).toBe(true)
    expect(result.detail).toContain('has not reached the API')
  })

  /*
   * A stream that has never reached the API flips connecting → reconnecting →
   * connecting on every retry. Keyed off that state the banner strobed; it is
   * keyed off the attempt counter, which only climbs, so both phases of a retry
   * must produce the same answer.
   */
  it('does not change its mind as a failing retry cycles between states', () => {
    const base = { reconnectAttempt: 4, lastUpdateAt: null }
    const connecting = computeFreshness(input({ ...base, connection: 'connecting' }))
    const reconnecting = computeFreshness(input({ ...base, connection: 'reconnecting' }))
    expect(connecting).toEqual(reconnecting)
    expect(connecting.announce).toBe(true)
  })

  // A clock that has stepped backwards (the Pi has no RTC and gets its time
  // from NTP when it finds a network) must not render a negative age.
  it('clamps a future timestamp to zero rather than reporting a negative age', () => {
    const result = computeFreshness(input({ lastUpdateAt: NOW + 60_000 }))
    expect(result.ageMs).toBe(0)
  })
})
