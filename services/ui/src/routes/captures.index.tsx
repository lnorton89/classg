import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { DownloadIcon, FileTextIcon, SquareIcon } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FormField, Input } from '@/components/ui/field'
import { Alert, EmptyState } from '@/components/ui/misc'
import { ApiError, api } from '@/lib/api/client'
import { capturesQuery, queryKeys } from '@/lib/api/queries'
import type { Capture, StartCaptureRequest } from '@/lib/api/types'
import { formatBytes, formatRelative, formatTimestamp } from '@/lib/format'

export const Route = createFileRoute('/captures/')({
  component: CapturesView,
  loader: ({ context }) => context.queryClient.ensureQueryData(capturesQuery()),
})

function CapturesView() {
  const { data } = useQuery(capturesQuery())
  const captures = data?.captures ?? []

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 sm:p-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Captures</h1>
        <p className="text-muted-foreground text-xs">
          Milestone 0 is capture-driven: a PCAP of your own drone powering up is the ground
          truth everything else is built against.
        </p>
      </div>

      <StartCaptureCard />

      {captures.length === 0 ? (
        <EmptyState title="No captures yet">
          Start one above, or run <code>scripts/first-capture.sh</code> on the Pi.
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

      <p className="text-muted-foreground text-[11px]">
        Monitor mode records every 802.11 frame in range, not only drone beacons — your
        neighbours&apos; networks are in these files. Treat a downloaded PCAP as sensitive and
        delete it when you are done.
      </p>
    </div>
  )
}

function StartCaptureCard() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<StartCaptureRequest>({
    iface: 'wlan1',
    channel: 6,
    duration_s: 120,
    label: 'first-flight',
  })

  const start = useMutation({
    mutationFn: (body: StartCaptureRequest) => api.startCapture(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.captures }),
  })

  const error = start.error instanceof ApiError ? start.error : null
  const fieldError = (field: string) => (error?.field === field ? error.message : null)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a capture</CardTitle>
      </CardHeader>
      <CardContent>
        {error?.isPrivilegesRequired ? (
          <Alert tone="warn" title="Elevated privileges required" className="mb-3">
            {error.message} Capture needs monitor mode, which needs CAP_NET_ADMIN. Nothing is
            transmitted either way — this is a receive-only capability.
          </Alert>
        ) : error && !error.field ? (
          <Alert tone="error" title={`Capture failed (${error.code})`} className="mb-3">
            {error.message}
          </Alert>
        ) : null}

        <form
          className="grid gap-3 sm:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault()
            start.mutate(form)
          }}
        >
          <FormField label="Interface" error={fieldError('iface')}>
            {(props) => (
              <Input
                {...props}
                value={form.iface}
                onChange={(event) => setForm((f) => ({ ...f, iface: event.target.value }))}
              />
            )}
          </FormField>

          <FormField
            label="Channel"
            hint="Weighted plan favours 6"
            error={fieldError('channel')}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={165}
                value={form.channel}
                onChange={(event) =>
                  setForm((f) => ({ ...f, channel: Number(event.target.value) }))
                }
              />
            )}
          </FormField>

          <FormField label="Duration (s)" error={fieldError('duration_s')}>
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={3600}
                value={form.duration_s}
                onChange={(event) =>
                  setForm((f) => ({ ...f, duration_s: Number(event.target.value) }))
                }
              />
            )}
          </FormField>

          <FormField label="Label">
            {(props) => (
              <Input
                {...props}
                value={form.label ?? ''}
                onChange={(event) => setForm((f) => ({ ...f, label: event.target.value }))}
              />
            )}
          </FormField>

          <div className="sm:col-span-4">
            <Button type="submit" size="touch" disabled={start.isPending}>
              {start.isPending ? 'Starting…' : 'Start capture'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function CaptureRow({ capture }: { capture: Capture }) {
  const queryClient = useQueryClient()
  const stop = useMutation({
    mutationFn: () => api.stopCapture(capture.capture_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.captures }),
  })

  const tone =
    capture.state === 'completed' ? 'ok' : capture.state === 'failed' ? 'down' : 'warn'

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
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
            {formatBytes(capture.size_bytes)} · {capture.frame_count} frames ·{' '}
            {formatRelative(capture.started_at)}
          </p>
          <p className="text-muted-foreground font-mono text-[11px]">
            {formatTimestamp(capture.started_at)}
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
              <DownloadIcon className="size-4" aria-hidden />
              <span>Download .pcap</span>
              <span className="sr-only">for {capture.filename}, opens in Wireshark</span>
            </a>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
