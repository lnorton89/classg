import type { Track } from '@/lib/api/types'

/**
 * Evidence classes that corroborate an identification but never make one.
 *
 * MIRRORS `corroboratingOnlyClasses` in services/fusion/track.go. Fusion is
 * authoritative — it refuses to move such a track past TENTATIVE — and this
 * copy exists only so the panel can say *why* a track is unidentified rather
 * than leaning on TENTATIVE, which a real aircraft also passes through in its
 * first two seconds.
 */
const CORROBORATING_ONLY = new Set<string>(['C', 'D', 'H'])

/**
 * Whether anything has identified this contact as an aircraft, as opposed to
 * merely being consistent with one.
 *
 * A class C hit means an OUI or SSID looked drone-like. On 2026-08-17 that was
 * a DJI-built access point on ch149 which sat in the list beside a real Remote
 * ID track, indistinguishable at a glance from a second aircraft.
 */
export function isIdentified(track: Track): boolean {
  const evidence = track.evidence ?? []
  // No evidence at all is missing data, not weak data — fusion attaches some to
  // every track it builds. Demoting on absence would hide a real aircraft
  // whenever a response arrives trimmed, so absence defers to fusion, which no
  // longer promotes a corroborating-only track in the first place.
  if (evidence.length === 0) return true
  return evidence.some((e) => !CORROBORATING_ONLY.has(e.class))
}
