/**
 * Which rail entry the current URL belongs to.
 *
 * The case that cannot be left to the router's own `activeProps`: Sensors and
 * Captures are the same route with a different pane selected, and lighting
 * both makes "where am I" unanswerable on the one page in the app with two
 * entries pointing at it.
 */
import { describe, expect, it } from 'vitest'

import {
  isNavItemActive,
  NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
  SECONDARY_NAV_ITEMS,
  visibleNavItems,
  type NavItem,
} from './nav-items'

function item(id: string): NavItem {
  const found = NAV_ITEMS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no nav item ${id}`)
  return found
}

function at(pathname: string) {
  return { pathname }
}

describe('the nav model', () => {
  it('keeps the daily destinations in the phone bar and the rest behind More', () => {
    // The bar divides its width equally, so the count is fixed by the
    // narrowest screen rather than by how many destinations the app has.
    expect(PRIMARY_NAV_ITEMS.map((entry) => entry.label)).toEqual([
      'Live',
      'Flights',
      'Sensors',
    ])
    expect(SECONDARY_NAV_ITEMS.map((entry) => entry.label)).toEqual([
      'Spectrum',
      'Captures',
      'Event log',
      'Settings',
      'Administration',
    ])
  })

  it('calls the /tracks route Flights, and still routes there', () => {
    // The URL is in bookmarks and in the operator guide; the word an operator
    // reads is not.
    expect(item('flights').to).toBe('/tracks')
  })

  it('no longer offers Timeline as a place of its own', () => {
    // It asked the Flights page's question from a second page carrying its own
    // window, and the two drifted. `/tracks?view=lanes` is the same band over
    // the list's window; `/timeline` redirects there for old bookmarks.
    expect(NAV_ITEMS.map((entry) => entry.to)).not.toContain('/timeline')
  })

  it('hides Administration from anyone without the role', () => {
    const asOperator = visibleNavItems(NAV_ITEMS, false).map((entry) => entry.id)
    expect(asOperator).not.toContain('admin')
    expect(visibleNavItems(NAV_ITEMS, true).map((entry) => entry.id)).toContain('admin')
  })

  it('divides what you watch from what you change, exactly once', () => {
    const groups = NAV_ITEMS.map((entry) => entry.group)
    const changes = groups.filter((group, i) => i > 0 && group !== groups[i - 1])
    expect(changes).toEqual(['manage'])
  })
})

describe('isNavItemActive', () => {
  it('matches Live only at the root, which is a prefix of every other path', () => {
    expect(isNavItemActive(item('live'), at('/'))).toBe(true)
    expect(isNavItemActive(item('live'), at('/tracks'))).toBe(false)
  })

  it('keeps Flights lit on a flight’s own page', () => {
    expect(isNavItemActive(item('flights'), at('/tracks'))).toBe(true)
    expect(isNavItemActive(item('flights'), at('/tracks/01K5ABC'))).toBe(true)
  })

  it('gives every entry a route of its own, so none can light two', () => {
    // The router stamps aria-current on any Link it considers active and that
    // stamp wins over anything passed in, so two entries sharing one route
    // light both. Captures is a route rather than a pane of Sensors for
    // exactly this reason.
    const paths = NAV_ITEMS.map((entry) => entry.to)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('lights Captures on a capture’s own detail page, and Sensors on neither', () => {
    expect(isNavItemActive(item('captures'), at('/captures/cap-1'))).toBe(true)
    expect(isNavItemActive(item('sensors'), at('/captures/cap-1'))).toBe(false)
    expect(isNavItemActive(item('captures'), at('/sensors'))).toBe(false)
  })

  it('does not treat a longer path segment as a match', () => {
    expect(isNavItemActive(item('sensors'), at('/sensors-archive'))).toBe(false)
  })
})
