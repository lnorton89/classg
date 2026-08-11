/**
 * Copy-to-clipboard for identifiers.
 *
 * Serials, MACs, ICAO addresses and track IDs are the things an operator
 * transcribes into an incident report or pastes into a search box, and
 * hand-typing `1581F5FMD24C1000ABCD` from a phone screen at night is how a
 * report ends up referring to a drone that does not exist.
 */
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/cn'

export interface CopyButtonProps {
  value: string
  /** Names the thing being copied, for the accessible label. */
  label: string
  className?: string
}

export function CopyButton({ value, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(id)
  }, [copied])

  return (
    <button
      type="button"
      // The label carries the state as well as the action: a screen-reader user
      // gets no benefit from an icon swapping from clipboard to tick.
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-6',
        'shrink-0 items-center justify-center rounded transition-colors',
        className,
      )}
      onClick={() => {
        // navigator.clipboard is undefined on insecure origins -- which is how
        // this is served on a Pi reached over plain http on a LAN address. The
        // types say it is always there; on the deployment that matters it is not.
        void navigator.clipboard
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false))
      }}
    >
      {copied ? (
        <CheckIcon className="text-ok size-3.5" aria-hidden />
      ) : (
        <CopyIcon className="size-3.5" aria-hidden />
      )}
    </button>
  )
}

/** Monospace identifier with a copy affordance. The pairing is used everywhere. */
export function CopyableId({
  value,
  label,
  className,
  truncate = true,
}: CopyButtonProps & { truncate?: boolean }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className={cn('font-mono', truncate && 'truncate')}>{value}</span>
      <CopyButton value={value} label={label} />
    </span>
  )
}
