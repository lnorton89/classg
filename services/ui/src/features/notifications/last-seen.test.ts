/**
 * The bell on a fresh session.
 *
 * The reported fault: opening the console in a browser that had never seen it
 * showed 10 unread, all of them flights from before anybody sat down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readLastSeen, writeLastSeen } from './last-seen'

const KEY = 'classg.notifications.lastSeenAt'

beforeEach(() => {
  window.localStorage.clear()
})

describe('the notification read watermark', () => {
  it('starts at the moment this browser first opened the console, not at zero', () => {
    // Zero means the beginning of time, which makes everything in the buffer
    // unread forever — and a badge that is never zero is a badge nobody reads.
    expect(readLastSeen(1_000_000)).toBe(1_000_000)
  })

  it('persists that first moment immediately', () => {
    // Not left to the first drawer open: a reload before anyone touches the
    // bell would otherwise start the count over from the beginning again.
    readLastSeen(1_000_000)
    expect(window.localStorage.getItem(KEY)).toBe('1000000')
    expect(readLastSeen(2_000_000)).toBe(1_000_000)
  })

  it('reads back what opening the drawer wrote', () => {
    writeLastSeen(1_234)
    expect(readLastSeen(9_999)).toBe(1_234)
  })

  it('treats an unparsable stored value as the beginning of the buffer', () => {
    // Everything unread is the safe direction for a corrupt watermark: it
    // shows too much rather than hiding a detection.
    window.localStorage.setItem(KEY, 'not a number')
    expect(readLastSeen(1_000_000)).toBe(0)
  })

  it('counts from now when storage is unavailable, as in a private window', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readLastSeen(1_000_000)).toBe(1_000_000)
    expect(() => writeLastSeen(1)).not.toThrow()
    getItem.mockRestore()
  })
})
