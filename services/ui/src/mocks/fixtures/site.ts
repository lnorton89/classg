/**
 * A synthetic but self-consistent field site for the mock backend.
 *
 * Coordinates match the worked example in docs/architecture/data-model.md so the
 * mocks, the docs, and anyone reading both tell the same story.
 */
export const SITE = {
  lat: 47.3769,
  lon: 8.5417,
  /** Ground elevation AMSL, used to keep geodetic altitude self-consistent. */
  elevationM: 425,
} as const

/** Fixed clock so fixtures are deterministic in tests; overridden at runtime. */
export const FIXTURE_EPOCH = Date.parse('2026-08-10T14:31:02.000Z')

export function isoAt(offsetSeconds: number, epoch: number = FIXTURE_EPOCH): string {
  return new Date(epoch + offsetSeconds * 1000).toISOString()
}

/** Metres north/east -> degrees, good enough at these scales. */
export function offsetLatLon(
  lat: number,
  lon: number,
  northM: number,
  eastM: number,
): { lat: number; lon: number } {
  const dLat = northM / 111_320
  const dLon = eastM / (111_320 * Math.cos((lat * Math.PI) / 180))
  return { lat: lat + dLat, lon: lon + dLon }
}
