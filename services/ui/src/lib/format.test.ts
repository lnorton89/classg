import { describe, expect, it } from 'vitest'

import { formatBytes } from './format'

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
