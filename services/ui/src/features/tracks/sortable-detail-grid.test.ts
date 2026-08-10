import { describe, expect, it } from 'vitest'

import { DEFAULT_TRACK_DETAIL_ORDER, normalizeTrackDetailOrder } from './track-detail-order'

describe('normalizeTrackDetailOrder', () => {
  it('accepts a complete custom order', () => {
    expect(
      normalizeTrackDetailOrder([
        'flight',
        'evidence',
        'identity',
        'position',
        'operator',
        'signal',
      ]),
    ).toEqual(['flight', 'evidence', 'identity', 'position', 'operator', 'signal'])
  })

  it('falls back when stored layout is incomplete or from another version', () => {
    expect(normalizeTrackDetailOrder(['flight', 'identity'])).toEqual(
      DEFAULT_TRACK_DETAIL_ORDER,
    )
    expect(normalizeTrackDetailOrder(null)).toEqual(DEFAULT_TRACK_DETAIL_ORDER)
  })
})
