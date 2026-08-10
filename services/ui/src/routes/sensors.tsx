import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RotateCwIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, DataRow } from '@/components/ui/misc'
import { CaptureHistory, SensorCaptureControl } from '@/features/captures/sensor-captures'
import { SensorHealthCard, SkyStateBanner } from '@/features/health/components'
import { computeSkyState } from '@/features/health/sky-state'
import { ApiError, api } from '@/lib/api/client'
import {
  capturesQuery,
  healthQuery,
  queryKeys,
  sensorsQuery,
  tracksQuery,
} from '@/lib/api/queries'
import { formatDuration } from '@/lib/format'

export const Route = createFileRoute('/sensors')({
  component: SensorsView,
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(healthQuery()),
      context.queryClient.ensureQueryData(sensorsQuery()),
      context.queryClient.ensureQueryData(capturesQuery()),
    ])
  },
})

function SensorsView() {
  const queryClient = useQueryClient()
  const { data: health } = useQuery(healthQuery())
  const { data: sensorsData } = useQuery(sensorsQuery())
  const { data: tracksData } = useQuery(tracksQuery())
  const [restartSuccess, setRestartSuccess] = useState<string | null>(null)

  const restart = useMutation({
    mutationFn: (sensorId: string) => api.restartSensor(sensorId),
    onMutate: () => setRestartSuccess(null),
    onSuccess: (result) => {
      setRestartSuccess(`Restart accepted for ${result.sensor_id}.`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: queryKeys.sensors })
    },
  })

  const activeTracks = tracksData?.tracks.filter((track) => track.state !== 'CLOSED').length ?? 0
  const skyState = computeSkyState(health, activeTracks)
  const sensors = sensorsData ?? health?.sensors ?? []
  const restartError = restart.error instanceof ApiError ? restart.error : null

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-3 sm:p-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Sensors and captures</h1>
        <p className="text-muted-foreground text-xs">
          Verify coverage, manage each sensor, and review passive recordings from one place.
        </p>
      </div>

      <SkyStateBanner state={skyState} />

      {restartSuccess ? (
        <Alert tone="ok" title="Restart requested">
          {restartSuccess}
        </Alert>
      ) : null}
      {restart.isError ? (
        <Alert tone="error" title="Restart failed">
          {restartError?.message ??
            (restart.error instanceof Error ? restart.error.message : 'Unknown error')}
        </Alert>
      ) : null}

      <section aria-labelledby="sensor-list-heading" className="space-y-3">
        <div>
          <h2 id="sensor-list-heading" className="text-base font-semibold">
            Sensor controls
          </h2>
          <p className="text-muted-foreground text-xs">
            Capture interface and defaults are loaded from the root <code>.env</code> through the
            API. Runtime limitations are shown on the affected sensor.
          </p>
        </div>

        <div className="grid items-start gap-3 lg:grid-cols-2">
          {sensors.map((sensor) => {
            const config = sensor.config
            const restartAvailable = config?.restart_available ?? true
            const isRestarting = restart.isPending && restart.variables === sensor.sensor_id

            return (
              <SensorHealthCard
                key={sensor.sensor_id}
                sensor={sensor}
                action={
                  <div className="mt-3">
                    {!restartAvailable ? (
                      <Alert tone="warn" title="Restart unavailable">
                        {config?.restart_unavailable_reason ??
                          'No restart command is available in the API runtime.'}
                      </Alert>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 w-full"
                      disabled={restart.isPending || !restartAvailable}
                      onClick={() => restart.mutate(sensor.sensor_id)}
                    >
                      <RotateCwIcon aria-hidden />
                      {isRestarting
                        ? `Restarting ${sensor.sensor_id}...`
                        : restartAvailable
                          ? `Restart ${sensor.sensor_id}`
                          : 'Restart unavailable'}
                    </Button>
                    <SensorCaptureControl sensor={sensor} />
                  </div>
                }
              />
            )
          })}
        </div>
      </section>

      <CaptureHistory />

      <Card>
        <CardHeader>
          <CardTitle>System</CardTitle>
        </CardHeader>
        <CardContent>
          <dl>
            <DataRow label="Status" value={health?.status ?? '-'} mono />
            <DataRow label="Uptime" value={health ? formatDuration(health.uptime_s) : '-'} mono />
            <DataRow label="Version" value={health?.version ?? '-'} mono />
          </dl>
          <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
            <strong className="text-foreground">Reading this page:</strong> zero detections from
            a <em>healthy</em> sensor means a quiet sky. Zero detections from an{' '}
            <em>unhealthy</em> sensor means nothing at all - do not trust the quiet. ClassG is
            receive-only; capture records packets but never transmits.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
