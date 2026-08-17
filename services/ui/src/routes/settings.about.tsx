import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CpuIcon, InfoIcon, ServerIcon, SlidersHorizontalIcon } from 'lucide-react'
import { useState } from 'react'
import { useFormat } from '@/app/use-format'
import { CopyButton } from '@/components/ui/copy-button'
import { Alert, DataRow } from '@/components/ui/misc'
import { SettingsCard } from '@/features/settings/controls'
import { HostHistory, type TelemetryWindow } from '@/features/settings/host-history'
import { HostRow } from '@/features/settings/host-row'
import { healthQuery, systemQuery, telemetryQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/settings/about')({
  component: AboutSettings,
  loader: ({ context }) => context.queryClient.ensureQueryData(systemQuery()),
})

/**
 * What this unit is, how it is configured, and how the Pi underneath is doing.
 *
 * The one rule that shapes it: a figure the API could not read renders as
 * "Unavailable" with the reason, never as a dash. A dash in a table of numbers
 * reads as "nothing to report" — which for a CPU temperature or an uptime is
 * indistinguishable from a real reading of zero, and this project treats
 * confidently-wrong worse than visibly-broken.
 */
function AboutSettings() {
  const format = useFormat()
  const system = useQuery(systemQuery())
  const health = useQuery(healthQuery())
  // 6h matches the API's default window: an evening's thermal behaviour.
  const [historyWindow, setHistoryWindow] = useState<TelemetryWindow>('6h')
  const telemetry = useQuery(telemetryQuery(historyWindow))

  if (system.isError) {
    return (
      <Alert tone="error" title="Could not read the receiver">
        The API did not answer <code className="font-mono text-xs">/system</code>. Everything on
        this page comes from the Pi, so there is nothing to show until it does — the Sensors
        page is where to look next.
      </Alert>
    )
  }

  const info = system.data
  const host = info?.host
  const pending = system.isPending

  return (
    <>
      <SettingsCard
        icon={InfoIcon}
        title="Build"
        description="Which binary is running. Quote the version when reporting anything."
      >
        <dl>
          <DataRow
            label="Version"
            mono
            value={
              pending ? (
                'Reading…'
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  {info?.build.version ?? EMPTY}
                  {info ? <CopyButton value={info.build.version} label="version" /> : null}
                </span>
              )
            }
          />
          <DataRow label="Go" value={info?.build.go_version ?? EMPTY} mono />
          <DataRow
            label="Revision"
            mono
            value={info?.build.revision ?? 'Not stamped'}
            hint={
              info?.build.revision
                ? info.build.revision_dirty
                  ? 'Built from a dirty working tree'
                  : undefined
                : 'Container builds exclude .git, so the toolchain has no commit to record'
            }
          />
          {info?.build.built_at ? (
            <DataRow label="Built" value={format.timestamp(info.build.built_at)} mono />
          ) : null}
        </dl>
      </SettingsCard>

      <SettingsCard
        icon={ServerIcon}
        title="Status"
        description="The same reading the header pill and the map banner use."
      >
        <dl>
          <DataRow label="Overall" value={health.data?.status ?? EMPTY} mono />
          <DataRow
            label="API uptime"
            value={health.data ? format.duration(health.data.uptime_s) : EMPTY}
            mono
            hint="Since the api process started, not since boot"
          />
          <DataRow
            label="Sensors healthy"
            mono
            value={
              health.data
                ? `${health.data.sensors.filter((s) => s.healthy).length} of ${health.data.sensors.length}`
                : EMPTY
            }
          />
        </dl>
      </SettingsCard>

      <SettingsCard
        icon={CpuIcon}
        title="Host"
        description="The Raspberry Pi this receiver runs on."
      >
        <dl>
          <HostRow
            label="Uptime"
            host={host}
            field="uptime_s"
            reason="uptime_s"
            render={(v) => format.duration(v)}
            hint="Since the Pi booted"
          />
          <HostRow
            label="Load"
            host={host}
            field="load1"
            reason="load"
            render={() =>
              host && host.load1 !== null
                ? `${host.load1.toFixed(2)}  ${host.load5?.toFixed(2) ?? '—'}  ${host.load15?.toFixed(2) ?? '—'}`
                : EMPTY
            }
            hint={host ? `1, 5 and 15 minutes across ${host.cpu_count} cores` : undefined}
          />
          <HostRow
            label="CPU temperature"
            host={host}
            field="cpu_temp_c"
            reason="cpu_temp_c"
            render={(v) => `${v.toFixed(1)} °C`}
          />
          <HostRow
            label="Memory available"
            host={host}
            field="mem_available_kb"
            reason="memory"
            render={(v) =>
              host?.mem_total_kb
                ? `${format.bytes(v * 1024)} of ${format.bytes(host.mem_total_kb * 1024)}`
                : format.bytes(v * 1024)
            }
          />
          <HostRow
            label="Disk free"
            host={host}
            field="disk_free_bytes"
            reason="disk"
            render={(v) =>
              host?.disk_total_bytes
                ? `${format.bytes(v)} of ${format.bytes(host.disk_total_bytes)}`
                : format.bytes(v)
            }
            hint={
              host?.disk_path ? `On ${host.disk_path}, where detections are stored` : undefined
            }
          />
          <DataRow
            label="Throttled"
            mono
            value={<span className="text-muted-foreground">Unavailable</span>}
            hint={
              host?.unavailable?.throttled ??
              'Undervoltage and thermal throttling are not readable from the api'
            }
          />
        </dl>
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
          <strong className="text-foreground">Why throttling is missing:</strong> it lives
          behind <code className="font-mono text-xs">vcgencmd</code>, which needs the binary and{' '}
          <code className="font-mono text-xs">/dev/vcio</code> — neither is in the api
          container. It is listed rather than hidden because a blank throttle flag must never be
          read as &ldquo;not throttled&rdquo;. Run{' '}
          <code className="font-mono text-xs">vcgencmd get_throttled</code> on the Pi.
        </p>
        <HostHistory
          data={telemetry.data}
          isPending={telemetry.isPending}
          isRefreshing={telemetry.isPlaceholderData}
          isError={telemetry.isError}
          window={historyWindow}
          onWindowChange={setHistoryWindow}
        />
      </SettingsCard>

      <SettingsCard
        icon={SlidersHorizontalIcon}
        title="Runtime"
        description="How this api was started. Changing any of it means restarting the service."
      >
        <dl>
          <DataRow label="Listening on" value={info?.runtime.listen ?? EMPTY} mono />
          <DataRow label="Store" value={info?.runtime.store ?? EMPTY} mono />
          <DataRow
            label="Serving the web app"
            value={
              info
                ? info.runtime.ui_dir === 'off'
                  ? 'No — nginx does'
                  : info.runtime.ui_dir
                : EMPTY
            }
            mono
            hint={
              info?.runtime.ui_dir === 'off'
                ? undefined
                : 'The Go binary is serving dist/, which can be a stale build'
            }
          />
          <DataRow label="Captures" value={info?.runtime.capture_dir ?? EMPTY} mono />
          <DataRow
            label="Cloud sync"
            value={info ? (info.runtime.turso_sync_configured ? 'Configured' : 'Off') : EMPTY}
            mono
            hint={
              info?.runtime.turso_sync_configured
                ? 'Detections, including operator positions, replicate off this unit'
                : undefined
            }
          />
          <DataRow
            label="Containerised"
            value={info ? (info.runtime.containerised ? 'Yes' : 'No') : EMPTY}
            mono
            hint={
              info?.runtime.containerised
                ? 'Which is why some host readings above are unavailable'
                : undefined
            }
          />
        </dl>
      </SettingsCard>
    </>
  )
}

const EMPTY = '—'
