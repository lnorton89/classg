import { beforeEach, describe, expect, it } from 'vitest'

import { createDismissalStore } from './dismissal-store'

describe('createDismissalStore', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('reads null before anything has been dismissed', () => {
    const store = createDismissalStore('test.dismissal.a')
    expect(store.read()).toBeNull()
  })

  it('remembers the last dismissed value', () => {
    const store = createDismissalStore('test.dismissal.b')
    store.dismiss('quiet')
    expect(store.read()).toBe('quiet')
  })

  it('a later dismissal replaces an earlier one', () => {
    const store = createDismissalStore('test.dismissal.c')
    store.dismiss('quiet')
    store.dismiss('degraded')
    expect(store.read()).toBe('degraded')
  })

  it('persists across separate store instances sharing a key — the whole point, since a remounted component creates a fresh instance', () => {
    createDismissalStore('test.dismissal.d').dismiss('quiet')
    expect(createDismissalStore('test.dismissal.d').read()).toBe('quiet')
  })

  it('keeps separately-keyed stores independent', () => {
    createDismissalStore('test.dismissal.e').dismiss('quiet')
    expect(createDismissalStore('test.dismissal.f').read()).toBeNull()
  })
})
