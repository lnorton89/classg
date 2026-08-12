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
            'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md',
            'px-3 py-1.5 text-sm font-medium transition-colors',
            'text-muted-foreground hover:text-foreground',
            'data-pressed:bg-card data-pressed:text-foreground data-pressed:shadow-xs',
            'data-pressed:ring-border data-pressed:ring-1',
            // Deliberately NOT min-w-0 in a row.
            //
            // `flex-1` is `flex: 1 1 0%`, so every option starts from a zero
            // basis and they end up equal -- which is the look this control
            // wants when it has room. `min-w-0` additionally lets an option
            // shrink below its own text, and together with the `truncate`
            // below that failure is silent: the layout still looks deliberate
            // while the label is gone. On the logs page, where the group is
            // shrink-to-fit inside a toolbar rather than stretched across a
            // card, it collapsed all four options to 61px and rendered
            // "Warnings" as "Wa..." with 1400px of empty space beside it.
            //
            // Leaving the automatic minimum in place means an option is never
            // narrower than its label, and the group's `flex-wrap` handles a
            // genuinely too-tight row by wrapping -- which is legible, where
            // clipping is not. Vertical keeps min-w-0: options are full width
            // there, and hints are long enough to want truncating.
            vertical && 'min-w-0 justify-start text-left',
            '[&_svg]:size-4 [&_svg]:shrink-0',
          )}
        >
          {option.icon}
          <span className={cn('flex flex-col', vertical && 'min-w-0')}>
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
