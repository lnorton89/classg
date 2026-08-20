import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { DownloadIcon, FileTextIcon, PlayIcon, SquareIcon } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FormField, Input } from '@/components/ui/field'
import { Alert, EmptyState } from '@/components/ui/misc'
import { ApiError, api } from '@/lib/api/client'
import { capturesQuery, queryKeys } from '@/lib/api/queries'
import type { Capture, SensorHealth, StartCaptureRequest } from '@/lib/api/types'
import { useFormat } from '@/app/use-format'

export function SensorCaptureControl({ sensor }: { sensor: SensorHealth }) {
  const queryClient = useQueryClient()
  const capture = sensor.config?.capture
  const [label, setLabel] = useState(capture?.label ?? `${sensor.sensor_id}-capture`)
  const [channel, setChannel] = useState(capture?.channel ?? 6)
  const [duration, setDuration] = useState(capture?.duration_s ?? 120)

  const start = useMutation({
    mutationFn: (body: StartCaptureRequest) => api.startCapture(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.captures }),
  })
  const error = start.error instanceof ApiError ? start.error : null

  if (!capture?.supported) {
    return (
      <p className="text-muted-foreground border-border mt-3 border-t pt-3 text-xs">
        Capture is not implemented for {sensor.sensor_kind.toUpperCase()} sensors yet.
      </p>
    )
  }

  const iface = capture.interface ?? ''

  return (
    <details className="border-border mt-3 border-t pt-3">
      <summary className="hover:text-foreground cursor-pointer text-xs font-medium">
        Capture settings
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-muted-foreground text-xs leading-relaxed">
          Records {sensor.sensor_id}&apos;s own adapter — the interface it reports on its
          heartbeat, falling back to <code>CLASSG_WIFI_INTERFACE</code> when it reports none. It
          is locked here so a browser cannot silently point capture at another device. Channel
          and defaults come from the API&apos;s centralized <code>.env</code>.
        </p>

        {error?.isPrivilegesRequired ? (
          <Alert tone="warn" title="Capture unavailable from this API runtime">
            {error.message}
          </Alert>
        ) : error ? (
          <Alert tone="error" title={`Capture failed (${error.code})`}>
            {error.message}
          </Alert>
        ) : null}

        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            start.mutate({ iface, channel, duration_s: duration, label })
          }}
        >
          <FormField label="Interface" hint={`read by ${sensor.sensor_id}`}>
            {(props) => <Input {...props} value={iface} readOnly className="font-mono" />}
          </FormField>
          <FormField label="Channel" hint="CLASSG_WIFI_CHANNEL">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={165}
                value={channel}
                onChange={(event) => setChannel(Number(event.target.value))}
              />
            )}
          </FormField>
          <FormField label="Duration (s)" hint="CLASSG_CAPTURE_DURATION_S">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={3600}
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
              />
            )}
          </FormField>
          <FormField label="Label" hint="CLASSG_CAPTURE_LABEL">
            {(props) => (
              <Input
                {...props}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </FormField>
          <div className="sm:col-span-2">
            <Button type="submit" size="touch" disabled={start.isPending || !iface}>
              <PlayIcon aria-hidden />
              {start.isPending ? 'Starting…' : `Start capture on ${sensor.sensor_id}`}
            </Button>
          </div>
        </form>
      </div>
    </details>
  )
}

export function CaptureHistory() {
  const { data } = useQuery(capturesQuery())
  const captures = data?.captures ?? []

  return (
    <section id="captures" aria-labelledby="capture-history-heading" className="space-y-3">
      <div>
        <h2 id="capture-history-heading" className="text-base font-semibold">
          Capture history
        </h2>
        <p className="text-muted-foreground text-xs">
          Passive recordings started from sensor settings or the host capture scripts.
        </p>
      </div>

      {captures.length === 0 ? (
        <EmptyState title="No captures yet">
          Open Capture settings on a sensor above to start one.
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {captures.map((capture) => (
            <li key={capture.capture_id}>
              <CaptureRow capture={capture} />
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted-foreground text-2xs leading-relaxed">
        Monitor mode records every 802.11 beacon in range, not only drone beacons. Treat PCAP
        files as sensitive and delete them when they are no longer needed.
      </p>
    </section>
  )
}

function CaptureRow({ capture }: { capture: Capture }) {
  const format = useFormat()
  const queryClient = useQueryClient()
  const stop = useMutation({
    mutationFn: () => api.stopCapture(capture.capture_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.captures }),
  })
  const tone =
    capture.state === 'completed' ? 'ok' : capture.state === 'failed' ? 'down' : 'warn'

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm">{capture.filename}</span>
            <Badge variant={tone}>{capture.state}</Badge>
            {capture.analysis?.analyzed ? (
              <Badge variant="muted">
                {capture.analysis.drone_transmitters ?? 0} drone transmitters
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            ch {capture.channel} · {capture.iface} · {capture.duration_s}s ·{' '}
            {format.bytes(capture.size_bytes)} · {capture.frame_count} frames ·{' '}
            {format.relative(capture.started_at)}
          </p>
          {capture.error ? (
            // A failed capture used to show only the badge. The API sends the
            // reason; without it an operator sees that something went wrong and
            // has nowhere to look for why.
            <p className="text-down mt-1 text-xs">{capture.error}</p>
          ) : null}
          <p className="text-muted-foreground font-mono text-2xs">
            {format.timestamp(capture.started_at)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {capture.state === 'running' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
            >
              <SquareIcon aria-hidden /> Stop
            </Button>
          ) : null}
          <Link
            to="/captures/$captureId"
            params={{ captureId: capture.capture_id }}
            className="border-border bg-background hover:bg-accent inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm font-medium"
          >
            <FileTextIcon className="size-4" aria-hidden /> Report
          </Link>
          {capture.state === 'completed' ? (
            <a
              href={api.captureDownloadUrl(capture.capture_id)}
              download={capture.filename}
              className="border-border bg-background hover:bg-accent inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm font-medium"
            >
              <DownloadIcon className="size-4" aria-hidden /> Download .pcap
            </a>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
