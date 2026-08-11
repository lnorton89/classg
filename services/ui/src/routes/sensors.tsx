import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CpuIcon, RotateCwIcon, SlidersHorizontalIcon } from 'lucide-react'
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
import { usePreferences } from '@/app/preferences-context'
import { useFormat } from '@/app/use-format'
import { useToast } from '@/components/ui/toast'
import { log } from '@/features/logs/log-store'
import { PageContainer } from '@/components/layout/page-container'
import { PageHeader, SectionHeader } from '@/components/layout/page-header'

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
  const format = useFormat()
  const toast = useToast()
  const { preferences } = usePreferences()
  const [restartSuccess, setRestartSuccess] = useState<string | null>(null)
  // Which sensor is awaiting a second click. A restart drops coverage for
  // several seconds, and on a phone the button sits directly under a thumb.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const restart = useMutation({
    mutationFn: (sensorId: string) => api.restartSensor(sensorId),
    onMutate: (sensorId) => {
      setRestartSuccess(null)
      log.action(`Restart requested for ${sensorId}`)
    },
    onSuccess: (result) => {
      setRestartSuccess(`Restart accepted for ${result.sensor_id}.`)
      setConfirmingId(null)
      toast.add({
        title: `Restart accepted for ${result.sensor_id}`,
        description: `${result.unit} is restarting. Coverage resumes when it heartbeats again.`,
        type: 'success',
      })
      log.info('sensor', `Restart accepted for ${result.sensor_id}`, { unit: result.unit })
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: queryKeys.sensors })
    },
    onError: () => setConfirmingId(null),
  })

  const activeTracks =
    tracksData?.tracks.filter((track) => track.state !== 'CLOSED').length ?? 0
  const skyState = computeSkyState(health, activeTracks)
  const sensors = sensorsData ?? health?.sensors ?? []
  const restartError = restart.error instanceof ApiError ? restart.error : null

  return (
    <PageContainer>
      <PageHeader
        icon={SlidersHorizontalIcon}
        title="Sensors and captures"
        description="Verify coverage, manage each sensor, and review passive recordings from one place."
      />

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
        <SectionHeader
          id="sensor-list-heading"
          icon={CpuIcon}
          title="Sensor controls"
          description={
            <>
              Capture interface and defaults are loaded from the root <code>.env</code> through
              the API. Runtime limitations are shown on the affected sensor.
            </>
          }
        />

        <div className="grid items-start gap-3 lg:grid-cols-2">
          {sensors.map((sensor) => {
            const config = sensor.config
            const restartAvailable = config?.restart_available ?? true
            const isRestarting = restart.isPending && restart.variables === sensor.sensor_id
            const isConfirming = confirmingId === sensor.sensor_id

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
                    {isConfirming ? (
                      <div className="mt-2 flex gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          className="flex-1"
                          disabled={restart.isPending}
                          onClick={() => restart.mutate(sensor.sensor_id)}
                        >
                          <RotateCwIcon aria-hidden />
                          Confirm restart — drops coverage
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2 w-full"
                        disabled={restart.isPending || !restartAvailable}
                        onClick={() =>
                          preferences.confirmDestructive
                            ? setConfirmingId(sensor.sensor_id)
                            : restart.mutate(sensor.sensor_id)
                        }
                      >
                        <RotateCwIcon aria-hidden />
                        {isRestarting
                          ? `Restarting ${sensor.sensor_id}...`
                          : restartAvailable
                            ? `Restart ${sensor.sensor_id}`
                            : 'Restart unavailable'}
                      </Button>
                    )}
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
            <DataRow
              label="Uptime"
              value={health ? format.duration(health.uptime_s) : '-'}
              mono
            />
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
    </PageContainer>
  )
}
