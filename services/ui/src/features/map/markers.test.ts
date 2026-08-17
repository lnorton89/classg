/**
 * Marker DOM, built without a map.
 *
 * MapLibre needs WebGL, which happy-dom does not have, so these exercise the
 * element factories directly. That is the whole of the marker's behaviour: the
 * map only positions the node it is handed.
 */
import { describe, expect, it, vi } from 'vitest'

import type { Formatters } from '@/app/use-format'
import { unitLabels } from '@/app/use-format'
import { formatHeading, formatRssi, splitSerial } from '@/lib/format'

import { createMannedMarker, updateMannedMarker } from './markers'

const format: Formatters = {
  length: (m) => `${String(m ?? 0)} m`,
  range: (m) => `${String(m ?? 0)} m`,
  speed: (v) => `${String(v ?? 0)} m/s`,
  altitudeFeet: (ft) => `${String(ft ?? 0)} ft`,
  rssi: formatRssi,
  heading: formatHeading,
  confidence: (v) => `${String(Math.round(v * 100))}%`,
  duration: (s) => `${String(s)}s`,
  bytes: (b) => `${String(b)} B`,
  coord: (v) => String(v),
  coords: (lat, lon) => `${String(lat)}, ${String(lon)}`,
  clock: (iso) => iso ?? '',
  timestamp: (iso) => iso ?? '',
  relative: (iso) => iso ?? '',
  when: (iso) => iso ?? '',
  zoneLabel: 'UTC',
  units: unitLabels('metric'),
  splitSerial,
}

const base = {
  icao: 'A1B2C3',
  callsign: 'UAL1234',
  headingDeg: 271,
  altFt: 7000,
  selected: false,
  format,
}

describe('manned markers', () => {
  it('is an inert image when nothing can be selected', () => {
    const node = createMannedMarker(base)

    expect(node.querySelector('button')).toBeNull()
    expect(node.getAttribute('role')).toBe('img')
    expect(node.getAttribute('aria-label')).toContain('Manned aircraft, ADS-B')
  })

  it('becomes a keyboard-reachable button that reports the ICAO address', () => {
    const onSelect = vi.fn()
    const node = createMannedMarker({ ...base, onSelect })

    const button = node.querySelector('button')
    expect(button).not.toBeNull()
    expect(button?.type).toBe('button')
    expect(button?.getAttribute('aria-pressed')).toBe('false')
    // The map keys manned markers by ICAO, and so does the contacts panel;
    // that shared key is what makes one click highlight both.
    button?.click()
    expect(onSelect).toHaveBeenCalledWith('A1B2C3')
  })

  it('keeps shape, colour and the word MANNED when selected', () => {
    const onSelect = vi.fn()
    const node = createMannedMarker({ ...base, onSelect })
    updateMannedMarker(node, { ...base, onSelect, selected: true })

    const button = node.querySelector('button')
    expect(button?.getAttribute('aria-pressed')).toBe('true')
    // Selected shows as size and weight — never by recolouring away one of the
    // three signals that separate manned traffic from a drone.
    expect(button?.className).toContain('scale-125')
    expect(node.querySelector('span.text-manned')).not.toBeNull()
    expect(node.textContent).toContain('MANNED UAL1234')
  })

  it('falls back to the ICAO address when the callsign is blank', () => {
    const node = createMannedMarker({ ...base, callsign: '   ', onSelect: vi.fn() })
    expect(node.textContent).toContain('MANNED A1B2C3')
  })
})
