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
