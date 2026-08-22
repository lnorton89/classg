/**
 * Group and name a sensor's open-ended `detail` map for display.
 *
 * The API passes `detail` through without a schema (a sensor reports whatever
 * it knows), and the card used to render it as-is: twenty-five rows in
 * alphabetical order, labelled by their JSON keys — `icaos 190`,
 * `uptime s 59979.8`, `hop overhead ms 6,053,880` — beside cards that are
 * carefully designed. This module is the difference between telemetry and a
 * debug dump: known keys get a person's label, a section, and a unit; unknown
 * keys still render, in an "Other" section, exactly as before — a future
 * sensor's new field degrades to the old behaviour instead of disappearing.
 */

export type DetailSection = 'Radio' | 'Traffic' | 'Errors' | 'Survey' | 'Other'

/** How the row's value wants to be rendered. `raw` falls back to formatDetailValue. */
export type DetailKind = 'seconds' | 'millis' | 'fraction' | 'prose' | 'raw'

interface KnownDetail {
  label: string
  section: Exclude<DetailSection, 'Other'>
  kind?: DetailKind
}

/**
 * Declaration order is display order within a section, so the map is arranged
 * by how an operator reads a sensor: what the radio is, what it hears, what
 * went wrong, what the driver says about occupancy.
 */
const KNOWN: Record<string, KnownDetail> = {
  // -- Radio: what this sensor is and how its feed is attached ------------
  iface: { label: 'Interface', section: 'Radio' },
  channel: { label: 'Current channel', section: 'Radio' },
  connected: { label: 'Feed connected', section: 'Radio' },
  source: { label: 'Feed source', section: 'Radio' },
  subscribers: { label: 'Feed subscribers', section: 'Radio' },
  reconnects: { label: 'Reconnects', section: 'Radio' },
  uptime_s: { label: 'Sensor uptime', section: 'Radio', kind: 'seconds' },
  plan: { label: 'Channel plan', section: 'Radio' },
  plan_fallback: { label: 'Widened to full plan', section: 'Radio' },
  companion_iface: { label: 'Companion receiver', section: 'Radio' },
  companion_present: { label: 'Companion present', section: 'Radio' },
  seconds_since_message: {
    label: 'Since last message',
    section: 'Radio',
    kind: 'seconds',
  },

  // -- Traffic: what it is hearing and how it spends its time -------------
  frames: { label: 'Frames heard', section: 'Traffic' },
  beacons: { label: 'Beacons heard', section: 'Traffic' },
  beacons_per_channel: { label: 'Beacons by channel', section: 'Traffic' },
  messages_read: { label: 'Messages read', section: 'Traffic' },
  parsed: { label: 'Messages parsed', section: 'Traffic' },
  icaos: { label: 'Aircraft heard', section: 'Traffic' },
  detections: { label: 'Drone detections', section: 'Traffic' },
  drone_hits_per_channel: { label: 'Drone hits by channel', section: 'Traffic' },
  class_a: { label: 'Class A (Remote ID)', section: 'Traffic' },
  class_b: { label: 'Class B (DJI DroneID)', section: 'Traffic' },
  class_c: { label: 'Class C (fingerprint)', section: 'Traffic' },
  hops: { label: 'Channel hops', section: 'Traffic' },
  scan_dwells: { label: 'Scan dwells', section: 'Traffic' },
  dwell_share: { label: 'Dwell share by channel', section: 'Traffic' },
  listening_fraction: {
    label: 'Time spent listening',
    section: 'Traffic',
    kind: 'fraction',
  },
  hop_overhead_ms: {
    label: 'Time lost to hopping',
    section: 'Traffic',
    kind: 'millis',
  },
  hop_latency_ms: {
    label: 'Cost per hop',
    section: 'Traffic',
    kind: 'millis',
  },
  hop_latency_measured: { label: 'Hop cost measured', section: 'Traffic' },
  escalations: { label: 'Escalations', section: 'Traffic' },
  currently_escalated: { label: 'Escalated right now', section: 'Traffic' },

  // -- Errors --------------------------------------------------------------
  channel_errors: { label: 'Channel errors', section: 'Errors' },
  parse_errors: { label: 'Parse errors', section: 'Errors' },
  read_errors: { label: 'Read errors', section: 'Errors' },
  unparsed: { label: 'Unparsed messages', section: 'Errors' },

  // -- Survey: the driver's own account of channel occupancy ---------------
  survey_available: { label: 'Survey available', section: 'Survey' },
  survey_seen: { label: 'Survey entries', section: 'Survey' },
  survey_reason: { label: 'Survey note', section: 'Survey', kind: 'prose' },
}

const KNOWN_ORDER = Object.keys(KNOWN)
const SECTION_ORDER: DetailSection[] = ['Radio', 'Traffic', 'Errors', 'Survey', 'Other']

export interface DetailRow {
  key: string
  label: string
  value: unknown
  kind: DetailKind
}

export interface DetailGroup {
  section: DetailSection
  rows: DetailRow[]
}

export function groupSensorDetail(detail: Record<string, unknown>): DetailGroup[] {
  const bySection = new Map<DetailSection, DetailRow[]>()
  for (const [key, value] of Object.entries(detail)) {
    const known = KNOWN[key]
    const section = known?.section ?? 'Other'
    const rows = bySection.get(section) ?? []
    rows.push({
      key,
      label: known?.label ?? key.replaceAll('_', ' '),
      value,
      kind: known?.kind ?? 'raw',
    })
    bySection.set(section, rows)
  }
  for (const rows of bySection.values()) {
    rows.sort((a, b) => {
      const ai = KNOWN_ORDER.indexOf(a.key)
      const bi = KNOWN_ORDER.indexOf(b.key)
      // Unknown keys (-1) go last, alphabetically, so they have a stable spot.
      if (ai === -1 && bi === -1) return a.key.localeCompare(b.key)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  }
  return SECTION_ORDER.filter((section) => bySection.has(section)).map((section) => ({
    section,
    rows: bySection.get(section) ?? [],
  }))
}
