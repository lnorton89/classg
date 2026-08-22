/**
 * Which of the unit's radios heard this track, and what each one measured.
 *
 * The track's own `rssi_dbm` is the peak across every receiver. On a unit with
 * two Wi-Fi adapters that is a mixed measure — the ALFA and the TP-Link have
 * different antennas and different gain, so the peak reports which radio hears
 * loudest, not how close the aircraft got. Split per receiver, each figure is
 * comparable with itself over time, which is the only way it means anything.
 *
 * Two receivers on one track is also corroboration a single radio cannot give:
 * independent hardware, independent driver, same aircraft.
 */
import type { Receiver } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { useFormat } from '@/app/use-format'

/** Sorted by contribution, so the radio doing the work reads first. */
function sortReceivers(receivers: Receiver[]): Receiver[] {
  return [...receivers].sort(
    (a, b) => b.detection_count - a.detection_count || a.sensor_id.localeCompare(b.sensor_id),
  )
}

export function ReceiverBreakdown({
  receivers,
  className,
}: {
  receivers: Receiver[]
  className?: string
}) {
  const format = useFormat()
  if (receivers.length === 0) return null

  const sorted = sortReceivers(receivers)
  const several = sorted.length > 1

  return (
    <div className={cn('space-y-2', className)}>
      <table className="w-full text-left text-xs">
        <caption className="sr-only">
          Detections and peak signal per receiver for this track
        </caption>
        <thead className="text-muted-foreground">
          <tr className="border-border border-b">
            <th scope="col" className="py-1.5 pr-2 font-medium">
              Receiver
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right font-medium">
              Detections
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right font-medium">
              Peak
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Last heard
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {sorted.map((rx) => (
            <tr key={rx.sensor_id}>
              <th scope="row" className="py-2 pr-2 font-normal">
                <span className="font-mono text-2xs">{rx.sensor_id}</span>
                <span className="text-muted-foreground ml-1.5 text-2xs">{rx.sensor_kind}</span>
              </th>
              <td className="tnum py-2 pr-2 text-right font-mono">{rx.detection_count}</td>
              <td className="tnum py-2 pr-2 text-right font-mono">
                {format.rssi(rx.rssi_dbm ?? null)}
              </td>
              <td className="text-muted-foreground py-2 text-right">
                {rx.last_seen ? format.relative(rx.last_seen) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {several ? (
        <p className="text-muted-foreground text-2xs leading-snug">
          Heard by {sorted.length} receivers — independent hardware on the same aircraft.
          Compare each peak against itself over time rather than against the others: the
          adapters differ in antenna and gain, so the loudest number is not the closest pass.
          Detections sum to more than the aircraft transmitted wherever the channel plans
          overlap and both radios caught the same beacon.
        </p>
      ) : null}
    </div>
  )
}
