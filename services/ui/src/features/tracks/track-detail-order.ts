export const DEFAULT_TRACK_DETAIL_ORDER = [
  'evidence',
  'identity',
  'flight',
  'position',
  'operator',
  'signal',
] as const

export type TrackDetailCardId = (typeof DEFAULT_TRACK_DETAIL_ORDER)[number]

export function normalizeTrackDetailOrder(value: unknown): TrackDetailCardId[] {
  if (!Array.isArray(value)) return [...DEFAULT_TRACK_DETAIL_ORDER]
  const expected = new Set<string>(DEFAULT_TRACK_DETAIL_ORDER)
  if (value.length !== expected.size || value.some((item) => !expected.has(String(item)))) {
    return [...DEFAULT_TRACK_DETAIL_ORDER]
  }
  return value as TrackDetailCardId[]
}

const STORAGE_KEY = 'classg.track-detail.card-order.v1'

export function readStoredTrackDetailOrder(): TrackDetailCardId[] {
  if (typeof window === 'undefined') return [...DEFAULT_TRACK_DETAIL_ORDER]
  try {
    return normalizeTrackDetailOrder(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'),
    )
  } catch {
    return [...DEFAULT_TRACK_DETAIL_ORDER]
  }
}

export function persistTrackDetailOrder(order: TrackDetailCardId[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Storage can be unavailable in privacy modes; dragging should still work for this session.
  }
}

/**
 * Forget a dragged layout, for the Tracks settings category.
 *
 * Only clears storage. The grid reads its order once on mount, so an already
 * open track detail keeps the order it is showing until it remounts — which is
 * the honest behaviour: nothing should rearrange itself under the cursor of
 * someone reading a track.
 */
export function resetTrackDetailOrder(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing stored to forget */
  }
}

/** Whether a dragged layout is currently stored, so the reset can be disabled. */
export function hasStoredTrackDetailOrder(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}
