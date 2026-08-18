/**
 * What the Wi-Fi adapter can say about spectrum.
 *
 * Not a sweep and not an FFT — the adapter cannot produce one. It is the
 * driver's own per-channel busy-time and noise counters, differenced over the
 * heartbeat interval and published in the sensor's detail. That covers 2.4 and
 * 5 GHz, which the SDR is physically deaf to (ADR-0004) and which is where
 * every DJI drone talks.
 *
 * It updates itself. Not from the socket, though: `health` frames carry the
 * heartbeat-only view, and applyFrame deliberately refuses to overwrite the
 * richer /sensors cache with it. So this rides that query's own 15 s poll,
 * which is a shade slower than the ~10 s heartbeat and entirely fast enough for
 * a measurement whose window is the heartbeat interval.
 *
 * There is no button because there is nothing to start — the measurement is a
 * by-product of listening, which is also why it costs no ADS-B.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangleIcon, WifiIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, EmptyState } from '@/components/ui/misc'
import { sensorsQuery } from '@/lib/api/queries'
import { cn } from '@/lib/cn'

import {
  busiest,
  formatChannel,
  groupByBand,
  surveyState,
  transmitting,
  type ChannelOccupancy,
} from './wifi-survey'

export function WifiOccupancyPanel() {
  const sensors = useQuery(sensorsQuery())
  const state = surveyState(sensors.data)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WifiIcon className="size-4" aria-hidden />
          Channel occupancy
        </CardTitle>
        <CardDescription>
          2.4 and 5 GHz, from the Wi-Fi adapter — the bands the SDR cannot tune at all. How much
          of the time the radio spent on a channel the medium was busy. A loud channel is a loud
          channel: this identifies nothing, and most of what it measures is other people&rsquo;s
          Wi-Fi.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {state.kind === 'no-sensor' ? (
          <EmptyState icon={WifiIcon} title="No Wi-Fi sensor is reporting">
            Occupancy comes from the sensor&rsquo;s own heartbeat, so it appears when the sensor
            does.
          </EmptyState>
        ) : state.kind === 'unsupported' ? (
          <Alert tone="info" title="This adapter reports no survey">
            The driver keeps no per-channel counters, or <code className="font-mono">iw</code>{' '}
            is not installed on the host. Detection is unaffected — this is one view fewer, not
            a fault.
          </Alert>
        ) : state.kind === 'warming' ? (
          <EmptyState icon={WifiIcon} title="Measuring the first window">
            The driver&rsquo;s counters are cumulative, so the first reading has nothing to
            compare against. The first window lands one heartbeat from now.
          </EmptyState>
        ) : state.kind === 'unknown' ? (
          // Deliberately NOT the "measuring" copy. A sensor that has never
          // mentioned a survey is not warming up -- nothing is measuring, and
          // saying otherwise promises a reading that will never arrive. This is
          // what a sensor build older than the feature looks like, which is
          // exactly what a unit mid-rollout has.
          <EmptyState icon={WifiIcon} title="This sensor reports no occupancy">
            The Wi-Fi sensor is healthy and detecting; it is running a build that predates
            channel occupancy, or has not completed a heartbeat since it started. Nothing is
            wrong with the radio.
          </EmptyState>
        ) : (
          <OccupancyReading channels={state.channels} />
        )}
      </CardContent>
    </Card>
  )
}

function OccupancyReading({ channels }: { channels: ChannelOccupancy[] }) {
  const groups = groupByBand(channels)
  const loudest = busiest(channels)
  const transmitters = transmitting(channels)

  return (
    <div className="space-y-4">
      {/* Receive-only is the constraint this whole project is built on, and the
          driver's own transmit counter is the one place the system can check
          itself against it rather than assert it. It should never fire. */}
      {transmitters.length > 0 ? (
        <Alert tone="error" title="This interface reports transmit time">
          {transmitters.map(formatChannel).join(', ')} — ClassG never transmits. Something else
          is using this adapter, or it is not in monitor mode. Stop it and check.
        </Alert>
      ) : null}

      {loudest ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Busiest right now: <span className="text-foreground">{formatChannel(loudest)}</span>{' '}
          at {(loudest.busyFraction * 100).toFixed(0)}% busy
          {loudest.noiseDbm !== null ? `, noise ${loudest.noiseDbm.toFixed(0)} dBm` : ''}.
        </p>
      ) : null}

      {groups.map((group) => (
        <div key={group.band}>
          <p className="label-caps mb-1.5">{group.label}</p>
          <ul className="space-y-1.5">
            {group.channels.map((channel) => (
              <ChannelBar key={channel.freqMHz} channel={channel} />
            ))}
          </ul>
        </div>
      ))}

      <p className="text-muted-foreground flex items-start gap-1.5 text-2xs leading-relaxed">
        <AlertTriangleIcon
          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
          aria-hidden
        />
        <span>
          Each window covers only the channels the hopper actually visited, so a channel missing
          here was not measured — it is not a quiet one. Dwell is weighted towards channel 6,
          which is where Remote ID lives.
        </span>
      </p>
    </div>
  )
}

function ChannelBar({ channel }: { channel: ChannelOccupancy }) {
  const percent = channel.busyFraction * 100
  // Three steps, not a gradient: the useful question is "is this channel a
  // problem", and a continuous hue ramp answers it less clearly than a
  // threshold does.
  const tone =
    channel.busyFraction >= 0.6
      ? 'bg-down/70'
      : channel.busyFraction >= 0.25
        ? 'bg-warn/70'
        : 'bg-ok/60'

  return (
    <li className="flex items-center gap-2">
      <span className="tnum text-muted-foreground w-16 shrink-0 text-xs">
        {formatChannel(channel)}
      </span>
      <span
        className="bg-muted relative h-4 min-w-0 flex-1 overflow-hidden rounded-sm"
        role="img"
        aria-label={`${formatChannel(channel)}: ${percent.toFixed(0)} percent busy`}
      >
        <span
          className={cn('absolute inset-y-0 left-0 rounded-sm transition-[width]', tone)}
          style={{ width: `${Math.max(percent, 1.5)}%` }}
        />
      </span>
      <span className="tnum w-10 shrink-0 text-right text-xs">{percent.toFixed(0)}%</span>
      <span className="tnum text-muted-foreground hidden w-16 shrink-0 text-right text-2xs sm:inline">
        {channel.noiseDbm !== null ? `${channel.noiseDbm.toFixed(0)} dBm` : '—'}
      </span>
      {channel.inUse ? (
        <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
          listening
        </Badge>
      ) : null}
    </li>
  )
}
