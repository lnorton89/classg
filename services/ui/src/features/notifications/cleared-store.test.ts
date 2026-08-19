import { describe, expect, it } from 'vitest'

import { clearedNotifications } from './cleared-store'

// The store is a module-level singleton, constructed once for the whole test
// file -- there is no reset between tests (deliberately: production has no
// need for one either). Every test below uses an id unique to itself instead
// of relying on a clean slate, so tests stay independent of run order.

describe('clearedNotifications', () => {
  it('reports nothing cleared for an id never passed to clear()', () => {
    expect(clearedNotifications.has(`track:untouched:${Math.random()}`)).toBe(false)
  })

  it('remembers a cleared id', () => {
    clearedNotifications.clear('track:abc')
    expect(clearedNotifications.has('track:abc')).toBe(true)
  })

  it('notifies subscribers when an id is cleared', () => {
    let notified = 0
    const unsubscribe = clearedNotifications.subscribe(() => {
      notified += 1
    })
    clearedNotifications.clear(`test:${Math.random()}`)
    unsubscribe()
    expect(notified).toBe(1)
  })

  it('does not notify subscribers for an id already cleared', () => {
    const id = `test:dup:${Math.random()}`
    clearedNotifications.clear(id)
    let notified = 0
    const unsubscribe = clearedNotifications.subscribe(() => {
      notified += 1
    })
    clearedNotifications.clear(id)
    unsubscribe()
    expect(notified).toBe(0)
  })

  it('persists cleared ids to sessionStorage', () => {
    clearedNotifications.clear('log:42')
    const raw = window.sessionStorage.getItem('classg.notifications.cleared')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw ?? '[]')).toContain('log:42')
  })
})
