/**
 * Render one sensor `detail` value for display.
 *
 * The detail map is deliberately open-ended -- a sensor reports whatever it
 * knows, and the API passes it through without a schema. Several of those
 * values are themselves maps: beacons_per_channel, drone_hits_per_channel,
 * dwell_share. String() turns every one of them into "[object Object]", which
 * is how the panel came to show three rows of nothing while claiming to be
 * telemetry.
 *
 * Nested maps are summarised rather than dumped: which channels the radio
 * actually spent its time on is the question these answer, and that is a
 * ranking, not a data structure.
 */

const MAX_ENTRIES = 6

export function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean' || typeof value === 'string') return String(value)

  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map(formatDetailValue).join(', ')
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    // An empty map is a real answer -- no beacons on any channel yet -- and
    // reads better as "none" than as "{}".
    if (entries.length === 0) return 'none'

    const numeric = entries.filter(([, v]) => typeof v === 'number') as [string, number][]
    if (numeric.length === entries.length) {
      // Fractions (dwell share) are far easier to read as percentages than as
      // 0.5760998618998958.
      const asShare = numeric.every(([, v]) => v >= 0 && v <= 1)
      const ranked = [...numeric].sort((a, b) => b[1] - a[1])
      const shown = ranked
        .slice(0, MAX_ENTRIES)
        .map(([k, v]) => `${k}: ${asShare ? `${(v * 100).toFixed(1)}%` : formatNumber(v)}`)
      const rest = ranked.length - shown.length
      return rest > 0 ? `${shown.join(', ')}, +${rest} more` : shown.join(', ')
    }

    return entries.map(([k, v]) => `${k}: ${formatDetailValue(v)}`).join(', ')
  }

  // Everything with a sensible string form is handled above. What reaches here
  // is a symbol or a function, which cannot appear in JSON from the API --
  // stringifying it would only reintroduce the "[object Object]" class of bug.
  return '—'
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString()
  // Long floats (listening_fraction: 0.8618144163771155) carry no meaning past
  // a couple of digits and push the value off the row.
  return Number(n.toFixed(3)).toString()
}
