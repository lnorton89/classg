/**
 * The shared furniture of a settings category.
 *
 * These were private to the old single-page `/settings`. Splitting that page
 * into one route per category made them shared, and shared is what keeps a
 * label, its hint and its control the same shape in every section — the thing
 * that made the original page readable at a glance.
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useId } from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'

/** A titled card with an explanation. One per topic within a category. */
export function SettingsCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="text-muted-foreground size-4" aria-hidden />
          {title}
        </CardTitle>
        {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint ? (
          <p className="text-muted-foreground mt-0.5 max-w-2xl text-xs leading-relaxed">
            {hint}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  )
}

export function ToggleRow({
  label,
  hint,
  checked,
  onCheckedChange,
  icon: Icon,
}: {
  label: string
  hint?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  icon?: LucideIcon
}) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="flex items-center gap-2 text-sm">
          {Icon ? <Icon className="text-muted-foreground size-4" aria-hidden /> : null}
          {label}
        </Label>
        {hint ? (
          <p
            id={hintId}
            className="text-muted-foreground mt-0.5 max-w-2xl text-xs leading-relaxed"
          >
            {hint}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={hint ? hintId : undefined}
      />
    </div>
  )
}

export function PreviewPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={cn('bg-muted/40 border-border rounded-md border p-3')}>
      <p className="label-caps">{title}</p>
      <dl className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">{children}</dl>
    </div>
  )
}

export function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  )
}
