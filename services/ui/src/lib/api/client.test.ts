import { afterEach, describe, expect, it, vi } from 'vitest'

import { API_BASE, api, unwrapConfigValue } from './client'

describe('unwrapConfigValue', () => {
  const plan = {
    channels: [{ channel: 6, freq_mhz: 2437, weight: 40 }],
  }

  it('unwraps the API config envelope', () => {
    expect(unwrapConfigValue({ value: plan, restart_required: false })).toEqual(plan)
  })

  it('accepts the legacy direct response shape', () => {
    expect(unwrapConfigValue(plan)).toEqual(plan)
  })
})

interface RecordedCall {
  url: string
  init?: RequestInit
}

/** The one request the test expects. Destructured rather than indexed because
 *  `calls[0]` is `T | undefined` under `noUncheckedIndexedAccess` and the lint
 *  config forbids both `!` and `as` to get rid of it. "Exactly one" is itself
 *  worth pinning: a client method that fired twice would pass a looser check. */
function only(calls: RecordedCall[]): RecordedCall {
  const [call, ...rest] = calls
  if (!call || rest.length > 0) {
    throw new Error(`expected exactly one request, saw ${calls.length}`)
  }
  return call
}

/** The request body as the JSON string the client serialised, not a stringified
 *  Blob or stream. */
function sentBody(call: RecordedCall): string {
  const body = call.init?.body
  if (typeof body !== 'string') throw new Error('request body was not a JSON string')
  return body
}

/**
 * Records the URL and init of every request and answers with `body`.
 * Returns the recorded calls so a test can assert on the query string, which
 * is the part of these endpoints that can silently go wrong.
 */
function stubFetch(body: unknown, status = 200) {
  const calls: RecordedCall[] = []
  // The client always calls fetch with a string URL; the other two arms are
  // here so the recorded value is a real URL rather than "[object Object]".
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api.tracks query parameters', () => {
  const empty = { tracks: [], next_cursor: null, total: 0 }

  it('sends the whole window and both identity facets', async () => {
    const calls = stubFetch(empty)
    await api.tracks({
      since: '2026-09-01T00:00:00Z',
      until: '2026-09-02T00:00:00Z',
      serial: '1581F3YTBJ9H003045J0',
      vendor: 'dji',
    })
    const url = new URL(only(calls).url, 'http://localhost')
    expect(url.searchParams.get('since')).toBe('2026-09-01T00:00:00Z')
    expect(url.searchParams.get('until')).toBe('2026-09-02T00:00:00Z')
    expect(url.searchParams.get('serial')).toBe('1581F3YTBJ9H003045J0')
    expect(url.searchParams.get('vendor')).toBe('dji')
  })

  // An unset chip must not become `until=undefined`, which the API would
  // reject as a malformed timestamp rather than ignore.
  it('omits the new params entirely when they are unset', async () => {
    const calls = stubFetch(empty)
    await api.tracks({ since: '2026-09-01T00:00:00Z' })
    const url = new URL(only(calls).url, 'http://localhost')
    expect(url.searchParams.has('until')).toBe(false)
    expect(url.searchParams.has('serial')).toBe(false)
    expect(url.searchParams.has('vendor')).toBe(false)
  })
})

describe('aircraft labels', () => {
  const label = {
    serial: 'SER-A',
    label: "Neighbour's Mini 4 Pro",
    flag: 'known' as const,
    updated_at: '2026-09-15T09:05:00Z',
  }

  it('fetches the whole set from one endpoint', async () => {
    const calls = stubFetch({ labels: [label] })
    const res = await api.aircraftLabels()
    expect(only(calls).url).toBe(`${API_BASE}/aircraft/labels`)
    expect(res.labels).toEqual([label])
  })

  it('escapes the serial in the path', async () => {
    const calls = stubFetch(label)
    await api.aircraftLabel('SER/A?x')
    expect(only(calls).url).toBe(`${API_BASE}/aircraft/SER%2FA%3Fx/label`)
  })

  it('PUTs the label and flag as a body', async () => {
    const calls = stubFetch(label)
    const res = await api.setAircraftLabel('SER-A', { label: label.label, flag: 'known' })
    expect(only(calls).init?.method).toBe('PUT')
    expect(JSON.parse(sentBody(only(calls)))).toEqual({
      label: "Neighbour's Mini 4 Pro",
      flag: 'known',
    })
    expect(res).toEqual(label)
  })

  // Clearing a label is a 204 with no body; resolving to undefined rather than
  // throwing on an empty JSON parse is what lets a caller tell the two apart.
  it('resolves to undefined when a label is cleared', async () => {
    stubFetch(null, 204)
    await expect(
      api.setAircraftLabel('SER-A', { label: '', flag: '' }),
    ).resolves.toBeUndefined()
  })
})
