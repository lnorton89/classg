/**
 * Height, speed and signal on one clock.
 *
 * Three readings the old page either buried or never drew: AGL and speed
 * existed only as columns in a 500-row table, and RSSI had its own chart with
 * its own x-axis in a card somewhere below. Stacked on a shared axis they
 * answer the question the table cannot — *when* did it climb, and was that the
 * same moment the signal dropped.
 *
 * The domain is the flight, passed in from the page so the scrubber, the map
 * and every lane agree on what "now" means.
 */
import { useMemo } from 'react'

import type { Detection, Position } from '@/lib/api/types'

import { pointMs } from './flight-speed'
import { ProfileLane, type ProfileDomain, type ProfileSeries } from './profile-lane'
import { samplesByReceiver } from './rssi-samples'
import { useFormat } from '@/app/use-format'

/**
 * Hues for the per-receiver RSSI traces.
 *
 * Identity, not magnitude, so these are categorical: the track hue for the
 * first radio and the operator hue for the second, both already defined and
 * both already distinguishable in either theme. A third radio falls back to the
 * neutral ink rather than to a generated hue — a colour nobody chose is a
 * colour nobody validated, and every lane carries a legend and a table anyway.
 */
const RECEIVER_COLOURS = ['var(--track)', 'var(--operator)', 'var(--muted-foreground)']

export function FlightProfiles({
  path,
  detections,
  domain,
  cursorMs,
  onHoverMs,
}: {
  path: Position[]
  detections: Detection[]
  domain: ProfileDomain
  cursorMs: number | null
  onHoverMs: (ms: number | null) => void
}) {
  const format = useFormat()

  // Every one of these walks the whole flight, and the cursor prop changes ten
  // times a second during a replay. Without the memos the series are rebuilt
  // on every frame to produce exactly the same arrays.
  const heights: ProfileSeries[] = useMemo(
    () => [
      {
        id: 'agl',
        label: 'Height AGL',
        points: path.flatMap((position) => {
          const ms = pointMs(position)
          const value = position.height_agl_m
          // Points that never carried a height are skipped rather than plotted
          // at zero. A trace that dives to the ground every time the broadcast
          // omitted a field is a picture of the field, not of the flight.
          return ms !== null && typeof value === 'number' ? [{ ms, value }] : []
        }),
      },
    ],
    [path],
  )

  const speeds: ProfileSeries[] = useMemo(
    () => [
      {
        id: 'speed',
        label: 'Ground speed',
        // Reported speeds only, deliberately: the map's ramp interpolates
        // across unreported points because a line has to be drawn somewhere,
        // but a chart can simply not draw what was not measured.
        points: path.flatMap((position) => {
          const ms = pointMs(position)
          const value = position.speed_mps
          return ms !== null && typeof value === 'number' ? [{ ms, value }] : []
        }),
      },
    ],
    [path],
  )

  const rssi: ProfileSeries[] = useMemo(
    () =>
      [...samplesByReceiver(detections).entries()].map(([sensorId, samples], index) => ({
        id: sensorId,
        label: sensorId,
        color: RECEIVER_COLOURS[index] ?? RECEIVER_COLOURS[RECEIVER_COLOURS.length - 1],
        points: samples.flatMap((sample) => {
          const ms = Date.parse(sample.ts)
          return Number.isFinite(ms) ? [{ ms, value: sample.rssi }] : []
        }),
      })),
    [detections],
  )

  return (
    <div className="flex flex-col gap-3">
      <ProfileLane
        title="Height AGL"
        unit={format.units.length}
        series={heights}
        domain={domain}
        cursorMs={cursorMs}
        onHoverMs={onHoverMs}
        format={(value) => format.length(value)}
        emptyNote="No point in this flight carried a height above ground."
      />
      <ProfileLane
        title="Ground speed"
        unit={format.units.speed}
        series={speeds}
        domain={domain}
        cursorMs={cursorMs}
        onHoverMs={onHoverMs}
        format={(value) => format.speed(value)}
        emptyNote="No point in this flight carried a ground speed."
      />
      <ProfileLane
        title="RSSI per receiver"
        unit="dBm"
        series={rssi}
        domain={domain}
        cursorMs={cursorMs}
        onHoverMs={onHoverMs}
        format={(value) => format.rssi(Math.round(value))}
        emptyNote="No detection on this track reported a signal level."
      />
      <p className="text-muted-foreground text-2xs leading-snug">
        One axis, the length of the flight. Signal strength indicates relative distance only,
        and only against itself — the radios differ in antenna and gain, so a step between lanes
        is a difference in hardware, not in range.
      </p>
    </div>
  )
}
