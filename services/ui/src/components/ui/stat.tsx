/**
 * Stat tile — one number, its label, and optionally what it means.
 *
 * The numeral is set in the display face at a size that reads across a room,
 * because these exist to be glanced at. The label stays small and the hint
 * smaller: the hierarchy is value, then name, then explanation.
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export type StatTone = 'default' | 'ok' | 'warn' | 'down' | 'muted'

const TONE: Record<StatTone, { value: string; icon: string; card: string }> = {
  default: { value: 'text-foreground', icon: 'text-muted-foreground', card: 'border-border' },
  ok: { value: 'text-foreground', icon: 'text-ok', card: 'border-ok/30' },
  warn: { value: 'text-warn', icon: 'text-warn', card: 'border-warn/40 bg-warn/[0.06]' },
  down: { value: 'text-down', icon: 'text-down', card: 'border-down/45 bg-down/[0.07]' },
  muted: {
    value: 'text-muted-foreground',
    icon: 'text-muted-foreground',
    card: 'border-border',
  },
}

export interface StatTileProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: LucideIcon
  tone?: StatTone
  className?: string
}

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  className,
}: StatTileProps) {
  const t = TONE[tone]
  return (
    <div className={cn('bg-card flex flex-col gap-1 rounded-lg border p-3', t.card, className)}>
      <div className="text-muted-foreground flex items-center gap-1.5">
        {Icon ? <Icon className={cn('size-3.5 shrink-0', t.icon)} aria-hidden /> : null}
        <span className="label-caps truncate">{label}</span>
      </div>
      <span className={cn('font-display tnum text-2xl leading-none font-bold', t.value)}>
        {value}
      </span>
      {hint ? (
        <span className="text-muted-foreground text-2xs leading-snug">{hint}</span>
      ) : null}
    </div>
  )
}
