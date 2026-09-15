/**
 * The URL contracts added with the app shell, in one place.
 *
 * The rule every one of them exists to keep: `validateSearch` runs BEFORE the
 * component, so a rejected value takes the whole page down rather than one
 * control. A stale link, a hand-edited query string, or a value from a build
 * that had a chip this one does not must all degrade to the default view.
 *
 * The Flights list's own schema has its own file — see tracks/tracks-search.test.ts.
 */
import { describe, expect, it } from 'vitest'

import { LOG_SOURCES } from '@/features/logs/log-store'

import { formatLogSources, logsSearchSchema, parseLogSources } from './logs'
import { spectrumSearchSchema } from './spectrum'

/*
 * `/timeline` had a schema of its own — a window enum it kept separately from
 * the Flights list's. That is exactly why the two drifted, and it is now a
 * redirect to `/tracks?view=lanes` with no search of its own; the window it
 * used to own is the list's `since` chip. See tracks/tracks-search.test.ts.
 */

describe('spectrumSearchSchema', () => {
  it('parses an empty search to no keys at all', () => {
    expect(spectrumSearchSchema.parse({})).toEqual({})
  })

  it('carries a band name through unchanged', () => {
    // Not an enum: the bands come from the sensor's own plan, so the schema
    // cannot know them and the panel falls back to the first band it does have.
    expect(spectrumSearchSchema.parse({ band: '2.4 GHz' })).toEqual({ band: '2.4 GHz' })
  })

  it('degrades a non-string rather than throwing', () => {
    expect(spectrumSearchSchema.parse({ band: 24 })).toEqual({ band: undefined })
  })
})

describe('logsSearchSchema', () => {
  it('parses an empty search to no keys at all', () => {
    expect(logsSearchSchema.parse({})).toEqual({})
  })

  it('round-trips every key', () => {
    const search = { level: 'warn', source: 'sensor,api', q: 'adapter vanished' }
    expect(logsSearchSchema.parse(search)).toEqual(search)
  })

  it('degrades a level it does not have rather than throwing', () => {
    expect(logsSearchSchema.parse({ level: 'trace' })).toEqual({ level: undefined })
  })
})

describe('log source list', () => {
  it('reads a comma-separated selection', () => {
    expect([...parseLogSources('sensor,api')]).toEqual(['sensor', 'api'])
  })

  it('treats an absent value as every source', () => {
    expect(parseLogSources(undefined).size).toBe(LOG_SOURCES.length)
  })

  it('drops a source this build does not have instead of showing nothing', () => {
    // A link from a build that had a source this one lacks must still open the
    // log, and an empty log looks like a fault rather than like a filter.
    expect([...parseLogSources('sensor,telepathy')]).toEqual(['sensor'])
    expect(parseLogSources('telepathy').size).toBe(LOG_SOURCES.length)
    expect(parseLogSources('').size).toBe(LOG_SOURCES.length)
  })

  it('writes nothing when every source is on, so the default stays out of the URL', () => {
    expect(formatLogSources(new Set(LOG_SOURCES))).toBeUndefined()
  })

  it('round-trips a narrowed selection', () => {
    const narrowed = new Set(['sensor', 'api'] as const)
    const written = formatLogSources(narrowed)
    expect(written).toBe('sensor,api')
    expect(parseLogSources(written)).toEqual(narrowed)
  })
})
