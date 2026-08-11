import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logStore, toCsv, toNdjson, type LogEntry } from './log-store'

/** Appends are batched on a timer, so every assertion has to advance it first. */
function flush(): void {
  vi.advanceTimersByTime(300)
}

describe('logStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    logStore.clear()
    logStore.setLimit(1000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('batches appends into one notification', () => {
    const listener = vi.fn()
    const unsubscribe = logStore.subscribe(listener)

    logStore.append({ level: 'info', source: 'ui', message: 'one' })
    logStore.append({ level: 'info', source: 'ui', message: 'two' })
    // Nothing has been published yet — that is the point of the batch.
    expect(logStore.getSnapshot()).toHaveLength(0)

    flush()
    expect(logStore.getSnapshot()).toHaveLength(2)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('drops the oldest entries once the buffer is full', () => {
    // The browser tab may be open for days on a 4 GB box; the buffer is bounded
    // and the UI reports what it lost rather than pretending it has everything.
    logStore.setLimit(50)
    for (let i = 0; i < 60; i += 1) {
      logStore.append({ level: 'info', source: 'ui', message: `entry ${i}` })
    }
    flush()

    const entries = logStore.getSnapshot()
    expect(entries).toHaveLength(50)
    expect(entries[0]?.message).toBe('entry 10')
    expect(logStore.getDropped()).toBe(10)
  })

  it('trims immediately when the limit is lowered', () => {
    for (let i = 0; i < 20; i += 1) {
      logStore.append({ level: 'info', source: 'ui', message: `entry ${i}` })
    }
    flush()
    logStore.setLimit(50) // clamped minimum is 50
    expect(logStore.getSnapshot()).toHaveLength(20)
  })

  it('rate-limits a burst of debug entries and says how many it dropped', () => {
    // A noisy RF environment must not be able to evict every interesting line
    // from the buffer in one second.
    for (let i = 0; i < 40; i += 1) {
      logStore.append({ level: 'debug', source: 'detection', message: `detection ${i}` })
    }
    logStore.append({ level: 'warn', source: 'sensor', message: 'sensor unhealthy' })
    flush()

    const entries = logStore.getSnapshot()
    const debugs = entries.filter((entry) => entry.level === 'debug')
    expect(debugs.length).toBeLessThan(40)
    expect(entries.some((entry) => entry.message.includes('not logged (rate limit)'))).toBe(
      true,
    )
    // The entry that matters survived the burst.
    expect(entries.at(-1)?.message).toBe('sensor unhealthy')
  })

  it('does not rate-limit anything above debug', () => {
    for (let i = 0; i < 40; i += 1) {
      logStore.append({ level: 'warn', source: 'sensor', message: `warning ${i}` })
    }
    flush()
    expect(logStore.getSnapshot()).toHaveLength(40)
  })
})

/** RFC 4180 enough for one row: quoted fields with doubled inner quotes. */
function parseCsvRow(row: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i] ?? ''
    if (quoted) {
      if (char === '"' && row[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
    } else {
      field += char
    }
  }
  fields.push(field)
  return fields
}

describe('log export', () => {
  const entries: LogEntry[] = [
    {
      id: 1,
      at: '2026-08-10T02:14:07.000Z',
      level: 'warn',
      source: 'sensor',
      message: 'Sensor wifi-0 unhealthy',
      detail: { reason: 'no frames for 120 s, "up"' },
      trackId: 'T1',
    },
  ]

  it('writes one self-contained JSON object per NDJSON line', () => {
    const line = toNdjson(entries)
    expect(line.split('\n')).toHaveLength(1)
    expect(JSON.parse(line)).toMatchObject({ level: 'warn', trackId: 'T1' })
  })

  it('escapes CSV fields so a detail containing commas and quotes round-trips', () => {
    const csv = toCsv(entries)
    const [header, row] = csv.split('\n')
    expect(header).toBe('timestamp,level,source,message,track_id,detail')

    const fields = parseCsvRow(row ?? '')
    expect(fields).toHaveLength(6)
    expect(fields[0]).toBe('2026-08-10T02:14:07.000Z')
    expect(fields[4]).toBe('T1')
    // The detail survives two layers of escaping — JSON, then CSV — intact.
    expect(JSON.parse(fields[5] ?? '')).toEqual(entries[0]?.detail)
  })
})
