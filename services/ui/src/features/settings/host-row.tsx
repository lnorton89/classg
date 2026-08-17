import type { ReactNode } from 'react'

import { DataRow } from '@/components/ui/misc'
import type { SystemHost } from '@/lib/api/types'

/**
 * A host reading that may not exist.
 *
 * `null` from `/system` means "could not be read", with the reason in
 * `host.unavailable`. Rendering that as a dash would put it in the same visual
 * language as a real value, and for a CPU temperature or an uptime a dash is
 * indistinguishable from a reading of zero. This says the word and carries the
 * reason underneath, which is the same rule `/health` follows for a sensor that
 * has never reported.
 */
export function HostRow({
  label,
  host,
  field,
  reason,
  render,
  hint,
}: {
  label: string
  host: SystemHost | undefined
  field: keyof SystemHost
  /** Key into host.unavailable, which groups more coarsely than the fields do. */
  reason: string
  render: (value: number) => ReactNode
  hint?: ReactNode
}) {
  if (!host) {
    return <DataRow label={label} value="Reading…" mono />
  }

  const raw = host[field]
  if (typeof raw !== 'number') {
    return (
      <DataRow
        label={label}
        mono
        value={<span className="text-muted-foreground">Unavailable</span>}
        hint={host.unavailable?.[reason] ?? 'Not reported by the receiver'}
      />
    )
  }

  return <DataRow label={label} value={render(raw)} mono hint={hint} />
}
