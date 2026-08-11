/**
 * Segmented control — a single choice among two to four options, all visible.
 *
 * Preferred over a `<Select>` wherever the options fit, because the whole point
 * of a settings screen is showing what the alternatives ARE. A dropdown hides
 * them behind an interaction and turns "what are my unit options" into a click.
 */
import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** Shown under the label. Keep it to a few words — it is a reminder, not docs. */
  hint?: string
  icon?: ReactNode
}

export interface SegmentedProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: SegmentedOption<T>[]
  'aria-label': string
  className?: string
  /** Stack vertically. Use when hints are long enough to wrap. */
  vertical?: boolean
  disabled?: boolean
}

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  vertical = false,
  disabled,
  'aria-label': ariaLabel,
}: SegmentedProps<T>) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      disabled={disabled}
      value={[value]}
      // An empty array means the operator pressed the already-selected option.
      // For a single choice that must be a no-op, not "no units at all".
      onValueChange={(next) => {
        // noUncheckedIndexedAccess already types this as T | undefined.
        const chosen = next[0]
        if (chosen) onValueChange(chosen)
      }}
      className={cn(
        'border-border bg-muted/50 inline-flex gap-1 rounded-lg border p-1',
        vertical ? 'w-full flex-col' : 'flex-wrap',
        className,
      )}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md',
            'px-3 py-1.5 text-sm font-medium transition-colors',
            'text-muted-foreground hover:text-foreground',
            'data-pressed:bg-card data-pressed:text-foreground data-pressed:shadow-xs',
            'data-pressed:ring-border data-pressed:ring-1',
            vertical && 'justify-start text-left',
            '[&_svg]:size-4 [&_svg]:shrink-0',
          )}
        >
          {option.icon}
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{option.label}</span>
            {option.hint ? (
              <span className="text-muted-foreground text-2xs truncate font-normal">
                {option.hint}
              </span>
            ) : null}
          </span>
        </Toggle>
      ))}
    </ToggleGroup>
  )
}
