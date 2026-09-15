/**
 * The Tracks list's URL contract.
 *
 * The rule the whole schema exists to keep: a stale or hand-edited URL must
 * degrade to the default view, never throw. `validateSearch` runs before the
 * component, so a rejected value takes the page down rather than one control.
 */
import { describe, expect, it } from 'vitest'

import { tracksSearchSchema } from './index'

describe('tracksSearchSchema', () => {
  it('parses an empty search to no keys at all', () => {
    // Absent rather than empty when unset, so the page's own URL stays clean
    // and a shared link carries only what was actually chosen.
    expect(tracksSearchSchema.parse({})).toEqual({})
  })

  it('round-trips every key', () => {
    const search = {
      q: 'dji',
      since: '7d',
      day: '2026-09-15',
      vendor: 'dji',
      evidence: 'A',
      operator: 'yes',
      group: 'none',
      sort: 'duration-desc',
      view: 'lanes',
    }
    expect(tracksSearchSchema.parse(search)).toEqual(search)
  })

  it('carries the lanes view, which is where /timeline went', () => {
    // The band used to be its own page with its own window, and the two
    // drifted. It is a rendering of this list now, so it is a key in this
    // list's URL and shares this list's window and filters.
    expect(tracksSearchSchema.parse({ view: 'lanes' }).view).toBe('lanes')
    expect(tracksSearchSchema.parse({ view: 'list' }).view).toBe('list')
  })

  it('drops a value it does not recognise instead of throwing', () => {
    expect(
      tracksSearchSchema.parse({
        since: 'last tuesday',
        evidence: 'Z',
        operator: 'maybe',
        group: 'colour',
        sort: 'vibes-desc',
        view: 'hologram',
      }),
    ).toEqual({
      since: undefined,
      evidence: undefined,
      operator: undefined,
      group: undefined,
      sort: undefined,
      view: undefined,
    })
  })

  it('rejects a day that is not YYYY-MM-DD', () => {
    expect(tracksSearchSchema.parse({ day: '15/09/2026' }).day).toBeUndefined()
    expect(tracksSearchSchema.parse({ day: '2026-9-5' }).day).toBeUndefined()
    expect(tracksSearchSchema.parse({ day: '2026-09-05' }).day).toBe('2026-09-05')
  })

  it('survives a wholly foreign search object', () => {
    expect(() => tracksSearchSchema.parse({ utm_source: 'somewhere', q: 42 })).not.toThrow()
    expect(tracksSearchSchema.parse({ q: 42 }).q).toBeUndefined()
  })
})
