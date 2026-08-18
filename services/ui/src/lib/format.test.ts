import { describe, expect, it } from 'vitest'

import { EMPTY, formatBytes, formatGoDuration } from './format'

const NBSP = '\u00a0'

describe('formatBytes', () => {
  it('keeps small counts as exact bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('labels 1024-based divisions with binary units', () => {
    expect(formatBytes(1024)).toBe(`1.0${NBSP}KiB`)
    expect(formatBytes(1024 * 1024)).toBe(`1.0${NBSP}MiB`)
    expect(formatBytes(1024 * 1024 * 1024)).toBe(`1.0${NBSP}GiB`)
  })

  it('never writes a decimal label on a binary division', () => {
    // The bug this pins down: dividing by 1024 while writing "MB" rendered a
    // 1 GB capture as "953.7 MB" — a number matching nothing the API reports.
    expect(formatBytes(1_000_000_000)).toBe(`953.7${NBSP}MiB`)
  })

  it('stays in GiB past the last unit rather than inventing TiB precision', () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe(`5120.0${NBSP}GiB`)
  })
})

describe('formatGoDuration', () => {
  // The one that reached the screen: ninety days, written the only way Go can
  // write it, rendered verbatim under a sentence about how long history is kept.
  it('reads a Go duration as a person would say it', () => {
    expect(formatGoDuration('2160h0m0s')).toBe('90 days')
    expect(formatGoDuration('720h')).toBe('30 days')
    expect(formatGoDuration('24h0m0s')).toBe('1 day')
    expect(formatGoDuration('6h0m0s')).toBe('6 hours')
    expect(formatGoDuration('1h0m0s')).toBe('1 hour')
    expect(formatGoDuration('90m')).toBe('90 minutes')
    expect(formatGoDuration('30s')).toBe('30s')
  })

  // Days only when they divide evenly: "1.5 days" is a worse way to say 36
  // hours, and nobody configures retention that way.
  it('does not invent fractional days', () => {
    expect(formatGoDuration('36h0m0s')).toBe('36 hours')
  })

  // This renders operator configuration. A value that was not understood is
  // better shown as typed than replaced with a dash or a confident guess.
  it('passes through anything that is not a duration', () => {
    expect(formatGoDuration('forever')).toBe('forever')
    expect(formatGoDuration('')).toBe(EMPTY)
    expect(formatGoDuration(null)).toBe(EMPTY)
  })
})
