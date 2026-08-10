import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RotateCwIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Alert, DataRow } from '@/components/ui/misc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SensorHealthCard, SkyStateBanner } from '@/features/health/components'
import { computeSkyState } from '@/features/health/sky-state'
import { api } from '@/lib/api/client'
import { healthQuery, queryKeys, tracksQuery } from '@/lib/api/queries'
import { formatDuration } from '@/lib/format'

export const Route = createFileRoute('/sensors')({
  component: SensorsView,
  loader: ({ context }) => context.queryClient.ensureQueryData(healthQuery()),
})

function SensorsView() {
  const queryClient = useQueryClient()
  const { data: health } = useQuery(healthQuery())
  const { data: tracksData } = useQuery(tracksQuery())

  const restart = useMutation({
    mutationFn: (sensorId: string) => api.restartSensor(sensorId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.health }),
  })

  const skyState = computeSkyState(health, tracksData?.tracks.length ?? 0)

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 sm:p-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Sensors</h1>
        <p className="text-muted-foreground text-xs">
          A drone detector that silently stops detecting is worse than one that is obviously
          offline. This page exists so that never happens quietly.
        </p>
      </div>

      <SkyStateBanner state={skyState} />

      {restart.isError ? (
        <Alert tone="error" title="Restart failed">
          {restart.error instanceof Error ? restart.error.message : 'Unknown error'}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {(health?.sensors ?? []).map((sensor) => (
          <SensorHealthCard
            key={sensor.sensor_id}
            sensor={sensor}
            action={
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full"
                disabled={restart.isPending}
                onClick={() => restart.mutate(sensor.sensor_id)}
              >
                <RotateCwIcon aria-hidden />
                Restart {sensor.sensor_id}
              </Button>
            }
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>System</CardTitle>
        </CardHeader>
        <CardContent>
          <dl>
            <DataRow label="Status" value={health?.status ?? '—'} mono />
            <DataRow
              label="Uptime"
              value={health ? formatDuration(health.uptime_s) : '—'}
              mono
            />
            <DataRow label="Version" value={health?.version ?? '—'} mono />
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            <strong className="text-foreground">Reading this page:</strong> zero detections from
            a <em>healthy</em> sensor means a quiet sky. Zero detections from an{' '}
            <em>unhealthy</em> sensor means nothing at all — do not trust the quiet. Restart is
            the only control here; ClassG is receive-only and there is no &ldquo;start
            transmitting&rdquo;.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
