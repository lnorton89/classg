/**
 * `/timeline` is a redirect now, and the thing worth pinning is where it lands.
 *
 * The URL is in the operator guide and in browser bookmarks. A 404 on a page
 * somebody reaches for mid-watch is the failure this route file exists to
 * prevent, and it would be an easy one to reintroduce by deleting a route that
 * no longer renders anything.
 */
import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import { Route } from './timeline'

function thrownByBeforeLoad(): unknown {
  try {
    // The route takes no context here: it decides before anything is loaded,
    // which is the whole reason the redirect lives in `beforeLoad`.
    Route.options.beforeLoad?.(undefined as never)
  } catch (error) {
    return error
  }
  return undefined
}

describe('the old Timeline URL', () => {
  it('redirects rather than rendering or 404ing', () => {
    expect(isRedirect(thrownByBeforeLoad())).toBe(true)
  })

  it('lands on the Flights page with the lanes view open', () => {
    const thrown = thrownByBeforeLoad() as { options: Record<string, unknown> }
    expect(thrown.options).toMatchObject({ to: '/tracks', search: { view: 'lanes' } })
  })
})
