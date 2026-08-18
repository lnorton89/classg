/**
 * Formatting helpers.
 *
 * The governing rule: never invent precision the data does not have, and never
 * render a placeholder that could be mistaken for a measurement. `null` altitude
 * shows as an em dash, not as 0 m.
 */

/** Coordinates get 6 decimals — both protocols carry 1e-7 degree resolution. */
export function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`
}

export const EMPTY = '—'

export function formatNumber(
  value: number | null | undefined,
  { digits = 0, unit = '' }: { digits?: number; unit?: string } = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY
  return `${value.toFixed(digits)}${unit ? `\u00a0${unit}` : ''}`
}

export function formatMetres(value: number | null | undefined): string {
  return formatNumber(value, { digits: 1, unit: 'm' })
}

export function formatSpeed(value: number | null | undefined): string {
  return formatNumber(value, { digits: 1, unit: 'm/s' })
}

export function formatRssi(value: number | null | undefined): string {
  return formatNumber(value, { digits: 0, unit: 'dBm' })
}

export function formatHeading(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY
  return `${Math.round(value)}°`
}

/** Confidence as a percentage. Never labelled as threat, priority, or risk. */
export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * Binary units, labelled as such. Capture sizes are file sizes, where 1024-based
 * arithmetic is the convention -- but dividing by 1024 while writing "MB" (10^6)
 * rendered a 1 GB capture as "953.7 MB", a number that matches nothing `ls -l`
 * or the API reports. KiB/MiB/GiB make the maths and the label agree.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)}\u00a0${units[unit]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return EMPTY
  const s = Math.floor(seconds % 60)
  const m = Math.floor((seconds / 60) % 60)
  const h = Math.floor((seconds / 3600) % 24)
  const d = Math.floor(seconds / 86400)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * A Go duration string, as something a person would say.
 *
 * The retention settings are stored as Go durations because the API parses
 * them with time.ParseDuration, and Go has no unit larger than an hour — so
 * ninety days is written `2160h`, and Go prints it back as `2160h0m0s`. That
 * string reached the screen verbatim, under a sentence explaining how long
 * history is kept. Nobody reads 2160h0m0s as three months.
 *
 * Returns the input unchanged when it is not a duration. This renders operator
 * configuration, and showing a value that was not understood beats showing a
 * confident wrong one or an em dash where their setting used to be.
 */
export function formatGoDuration(raw: string | null | undefined): string {
  if (!raw) return EMPTY
  const text = raw.trim()
  const match = /^(-?)(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(
    text,
  )
  if (!match || (!match[2] && !match[3] && !match[4])) return text

  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  const seconds = Number(match[4] ?? 0)
  const total = hours * 3600 + minutes * 60 + seconds
  if (!Number.isFinite(total) || total <= 0) return text

  const sign = match[1] === '-' ? '-' : ''
  const days = total / 86400
  // Only when it divides evenly. "1.5 days" is a worse way to say 36 hours,
  // and a retention window is almost always a round number of one unit.
  if (days >= 1 && Number.isInteger(days)) {
    return `${sign}${days} ${days === 1 ? 'day' : 'days'}`
  }
  const asHours = total / 3600
  if (asHours >= 1 && Number.isInteger(asHours)) {
    return `${sign}${asHours} ${asHours === 1 ? 'hour' : 'hours'}`
  }
  const asMinutes = total / 60
  if (asMinutes >= 1 && Number.isInteger(asMinutes)) {
    return `${sign}${asMinutes} ${asMinutes === 1 ? 'minute' : 'minutes'}`
  }
  return `${sign}${formatDuration(total)}`
}

/** "3s ago" / "18m ago". Coarse on purpose — false precision here is noise. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return EMPTY
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return EMPTY
  const delta = Math.max(0, Math.round((now - then) / 1000))
  if (delta < 5) return 'just now'
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return EMPTY
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EMPTY
  return TIME_FMT.format(date)
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return EMPTY
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EMPTY
  return date.toISOString().replace('T', ' ').replace('Z', 'Z')
}

/**
 * ANSI/CTA-2063-A serials embed a 4-character manufacturer code. Splitting it out
 * matters because it survives MAC randomisation — see track.schema.json.
 */
export function splitSerial(serial: string | null | undefined): {
  manufacturerCode: string | null
  rest: string | null
} {
  if (!serial || serial.length < 5) return { manufacturerCode: null, rest: serial ?? null }
  return { manufacturerCode: serial.slice(0, 4), rest: serial.slice(4) }
}
