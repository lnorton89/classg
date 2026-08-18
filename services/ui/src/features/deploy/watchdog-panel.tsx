/**
 * Whether the unit has been repairing itself, and whether it has given up.
 *
 * The design rule this renders: **self-repair must make faults more visible,
 * not less.** A watchdog that quietly restarts a dying sensor every two minutes
 * turns a hardware failure into a mystery, so this leads with `needs_hands` —
 * the watchdog's way of saying it has climbed its whole ladder and stopped.
 *
 * `state_age_s` gets the same treatment it gets on the deployment panel, and
 * for a sharper reason: nothing else on this box notices when the thing that
 * notices things has itself stopped running.
 */
import { useQuery } from '@tanstack/react-query'
import { HeartPulseIcon } from 'lucide-react'

import { useFormat } from '@/app/use-format'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, DataList, DataRow, Skeleton } from '@/components/ui/misc'
import { watchdogQuery } from '@/lib/api/queries'

/** The timer runs every two minutes; three misses is unambiguous. */
const STALE_AFTER_S = 6 * 60

export function WatchdogPanel() {
  const format = useFormat()
  const status = useQuery(watchdogQuery())

  if (status.isPending) return <Skeleton className="h-40 w-full" />

  const w = status.data
  if (!w) return null

  if (!w.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HeartPulseIcon className="size-4" aria-hidden />
            Self-repair
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert tone="info" title="No watchdog on this unit">
            {w.reason ?? 'Not configured.'} Without it, a sensor that exhausts its systemd
            restart limit stays dead until someone signs in.
          </Alert>
        </CardContent>
      </Card>
    )
  }

  const stale = w.state_age_s !== undefined && w.state_age_s > STALE_AFTER_S

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <HeartPulseIcon className="size-4" aria-hidden />
          Self-repair
          {w.needs_hands ? <Badge variant="down">needs attention</Badge> : null}
          {w.actions_taken > 0 ? <Badge variant="warn">repairing</Badge> : null}
        </CardTitle>
        <CardDescription>
          The sensor units stop restarting themselves after five failures, on purpose — an
          unbounded retry against an unplugged adapter is a loop that looks like activity. This
          is the supervised retry that follows: bounded, escalating, and written down.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* First, because it is the one thing here that is not self-correcting. */}
        {w.needs_hands ? (
          <Alert tone="error" title="The watchdog has stopped trying">
            <span className="font-mono">{w.needs_hands}</span> did not come back after every
            attempt on the ladder. It is not being restarted any more — repeating a failed
            repair for ever would turn this into background noise. This one needs a person.
          </Alert>
        ) : null}

        {stale ? (
          <Alert tone="warn" title="The watchdog itself has not run recently">
            Last pass {w.last_check_at ? format.timestamp(w.last_check_at) : 'unknown'}. It
            should run every two minutes, so nothing is currently watching for faults. On the
            unit:{' '}
            <code className="font-mono text-xs">systemctl status classg-watchdog.timer</code>
          </Alert>
        ) : null}

        <DataList>
          <DataRow
            label="Last pass"
            value={w.last_check_at ? format.timestamp(w.last_check_at) : 'never'}
            hint={w.state_age_s !== undefined ? `${w.state_age_s}s ago` : undefined}
          />
          <DataRow
            label="Repairs this pass"
            value={w.actions_taken === 0 ? 'none needed' : String(w.actions_taken)}
          />
          <DataRow
            label="API"
            value={
              w.api_healthy ? (
                <Badge variant="ok">answering</Badge>
              ) : (
                <Badge variant="down">down</Badge>
              )
            }
          />
          <DataRow
            label="Wi-Fi adapter"
            value={
              w.wifi_adapter_present ? (
                <Badge variant="ok">on the bus</Badge>
              ) : (
                <Badge variant="down">absent</Badge>
              )
            }
            // An absent adapter is hardware. Saying so stops someone hunting a
            // software fault that is not there.
            hint={
              w.wifi_adapter_present ? undefined : 'hardware — restarting software cannot help'
            }
          />
          <DataRow
            label="SDR"
            value={
              w.sdr_present ? (
                <Badge variant="ok">on the bus</Badge>
              ) : (
                <Badge variant="down">absent</Badge>
              )
            }
            hint={w.sdr_present ? undefined : 'hardware — ADS-B will read degraded'}
          />
        </DataList>

        {w.log && w.log.length > 0 ? (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-2xs">
              Last watchdog pass ({w.log.length} line{w.log.length === 1 ? '' : 's'})
            </summary>
            <pre className="bg-muted/40 mt-2 max-h-64 overflow-auto rounded-md p-2 font-mono text-2xs whitespace-pre-wrap">
              {w.log.join('\n')}
            </pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  )
}
