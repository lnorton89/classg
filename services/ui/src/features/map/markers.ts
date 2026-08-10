/**
 * Map markers, built as DOM rather than MapLibre symbol layers.
 *
 * Why DOM:
 *   - Symbol layers need a sprite, and text labels need glyph PBFs. Shipping
 *     neither is what makes the no-tiles fallback work with zero assets.
 *   - DOM markers are real focusable elements, so the map's contacts are
 *     keyboard-reachable and have accessible names. A canvas is opaque to a
 *     screen reader; a <button> is not.
 *   - There are tens of contacts, not thousands. The performance argument for
 *     symbol layers does not apply at this scale.
 *
 * Colour never encodes urgency. Confidence varies opacity and ring weight within
 * one hue, because `confidence` answers "is this really a drone" and rendering it
 * as a red/amber/green scale would restate it as a threat level.
 */
import type { Track } from '@/lib/api/types'
import { formatConfidence, formatHeading, formatMetres } from '@/lib/format'

export type ContactKind = 'drone' | 'operator' | 'manned'

/** 0.35 -> 1.0. Even a 0.10 OUI-only hint stays visible; it just recedes. */
export function confidenceOpacity(confidence: number): number {
  return Math.round((0.35 + 0.65 * Math.min(1, Math.max(0, confidence))) * 100) / 100
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

const ARROW_SVG = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <path d="M12 2 L19.5 21 L12 16.6 L4.5 21 Z" fill="currentColor" stroke="currentColor"
        stroke-width="1.2" stroke-linejoin="round" />
</svg>`

const CHEVRON_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
  <path d="M12 3 L21 20 L12 15 L3 20 Z" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linejoin="round" />
</svg>`

const OPERATOR_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
  <circle cx="12" cy="7.5" r="3.4" fill="currentColor" />
  <path d="M4.5 20.5 a7.5 7.5 0 0 1 15 0 Z" fill="currentColor" />
</svg>`

export interface DroneMarkerOptions {
  track: Track
  selected: boolean
  onSelect: (trackId: string) => void
}

/** Aircraft: filled arrow, rotated to its reported track, trailing a history line. */
export function createDroneMarker(options: DroneMarkerOptions): HTMLElement {
  const wrapper = el('div', 'classg-marker classg-marker--drone')
  const button = document.createElement('button')
  button.type = 'button'
  button.className =
    'group relative flex size-11 items-center justify-center rounded-full transition-transform ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
  wrapper.append(button)

  const rotator = el('span', 'block text-track transition-transform duration-500 ease-linear')
  rotator.innerHTML = ARROW_SVG
  button.append(rotator)

  const ring = el(
    'span',
    'pointer-events-none absolute inset-1.5 rounded-full border border-track/60',
  )
  button.append(ring)

  const label = el(
    'span',
    'pointer-events-none absolute top-full left-1/2 -translate-x-1/2 whitespace-nowrap ' +
      'rounded bg-background/85 px-1 py-px font-mono text-[10px] leading-tight text-foreground ' +
      'ring-1 ring-border',
  )
  wrapper.append(label)

  updateDroneMarker(wrapper, options)
  button.addEventListener('click', () => options.onSelect(options.track.track_id))
  return wrapper
}

export function updateDroneMarker(node: HTMLElement, options: DroneMarkerOptions): void {
  const { track, selected } = options
  const button = node.querySelector('button')
  const rotator = node.querySelector<HTMLElement>('span.block')
  const ring = node.querySelector<HTMLElement>('span.absolute.inset-1\\.5')
  const label = node.querySelector<HTMLElement>('span.top-full')
  if (!button || !rotator || !label) return

  const heading = track.current?.track_deg ?? null
  const coasting = track.state === 'COASTING'
  const opacity = confidenceOpacity(track.confidence)

  rotator.style.transform = `rotate(${heading ?? 0}deg)`
  rotator.style.opacity = String(coasting ? opacity * 0.55 : opacity)
  rotator.classList.toggle('text-track-dim', coasting)
  rotator.classList.toggle('text-track', !coasting)

  if (ring) {
    // Ring weight, not hue, carries how corroborated the track is.
    ring.style.opacity = String(Math.min(1, track.confidence + 0.15))
    ring.style.borderWidth = track.confidence >= 0.6 ? '2px' : '1px'
    ring.style.borderStyle = coasting ? 'dashed' : 'solid'
  }

  button.classList.toggle('scale-125', selected)
  button.setAttribute('aria-pressed', String(selected))

  const name = track.identity?.serial ?? track.identity?.macs?.[0] ?? track.track_id.slice(-6)
  label.textContent = name.length > 14 ? `…${name.slice(-11)}` : name

  const parts = [
    'Drone track',
    name,
    `state ${track.state.toLowerCase()}`,
    `confidence ${formatConfidence(track.confidence)}`,
    heading === null ? 'heading unknown' : `heading ${formatHeading(heading)}`,
    track.current?.height_agl_m != null
      ? `height ${formatMetres(track.current.height_agl_m)}`
      : 'height unknown',
    track.operator ? 'operator position known' : 'operator position not broadcast',
  ]
  button.setAttribute('aria-label', `${parts.join(', ')}. Open track detail.`)
  button.title = parts.slice(0, 5).join(' · ')
}

export interface MannedMarkerOptions {
  icao: string
  callsign: string | null
  headingDeg: number | null
  altFt: number | null
}

/**
 * Manned traffic: hollow chevron, off-white, always labelled "MANNED".
 * Different shape, different fill treatment, different colour and an explicit
 * word — three independent signals, so it survives colour-blindness and a
 * sun-washed phone screen alike.
 */
export function createMannedMarker(options: MannedMarkerOptions): HTMLElement {
  const wrapper = el('div', 'classg-marker classg-marker--manned')
  const inner = el('div', 'flex flex-col items-center gap-0.5')
  wrapper.append(inner)

  const rotator = el('span', 'block text-manned')
  rotator.innerHTML = CHEVRON_SVG
  inner.append(rotator)

  const label = el(
    'span',
    'whitespace-nowrap rounded bg-background/85 px-1 py-px font-mono text-[10px] ' +
      'leading-tight text-manned ring-1 ring-manned/40',
  )
  inner.append(label)

  updateMannedMarker(wrapper, options)
  return wrapper
}

export function updateMannedMarker(node: HTMLElement, options: MannedMarkerOptions): void {
  const rotator = node.querySelector<HTMLElement>('span.block')
  const label = node.querySelector<HTMLElement>('span.whitespace-nowrap')
  if (!rotator || !label) return

  rotator.style.transform = `rotate(${options.headingDeg ?? 0}deg)`
  const name = options.callsign?.trim() || options.icao
  label.textContent = `MANNED ${name}`

  const description = [
    'Manned aircraft, ADS-B',
    name,
    options.altFt === null ? 'altitude unknown' : `${options.altFt} feet`,
    'not a drone',
  ].join(', ')
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', description)
  node.title = description
}

export interface OperatorMarkerOptions {
  trackId: string
  label: string
}

/**
 * Operator: a ground position, not an aircraft. Distinct hue, distinct glyph
 * (a person, not an arrow), no heading, and a dashed tether to the aircraft it
 * belongs to. Conflating a person standing in a field with an aircraft would be
 * plainly confusing.
 */
export function createOperatorMarker(options: OperatorMarkerOptions): HTMLElement {
  const wrapper = el('div', 'classg-marker classg-marker--operator')
  const inner = el('div', 'flex flex-col items-center')
  wrapper.append(inner)

  const glyph = el(
    'span',
    'flex size-6 items-center justify-center rounded-sm bg-background/80 text-operator ' +
      'ring-1 ring-operator/70',
  )
  glyph.innerHTML = OPERATOR_SVG
  inner.append(glyph)

  const label = el(
    'span',
    'mt-0.5 whitespace-nowrap rounded bg-background/85 px-1 py-px text-[10px] ' +
      'leading-tight font-medium text-operator ring-1 ring-operator/40',
  )
  label.textContent = 'OPERATOR'
  inner.append(label)

  const description = `Operator ground position for ${options.label}. Not an aircraft.`
  wrapper.setAttribute('role', 'img')
  wrapper.setAttribute('aria-label', description)
  wrapper.title = description
  return wrapper
}
