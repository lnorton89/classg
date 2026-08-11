import { Select as BaseSelect } from '@base-ui/react/select'
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react'

import { cn } from '@/lib/cn'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export interface SelectProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: SelectOption<T>[]
  /** Accessible name. Required — an unlabelled select is a screen-reader dead end. */
  'aria-label': string
  id?: string
  className?: string
  disabled?: boolean
}

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  className,
  disabled,
  id,
  'aria-label': ariaLabel,
}: SelectProps<T>) {
  return (
    <BaseSelect.Root
      value={value}
      // Base UI types the callback value as nullable for clearable selects.
      // None of ours are clearable, so a null never arrives.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      onValueChange={(next) => onValueChange(next!)}
      disabled={disabled}
      // Without `items`, `<Select.Value />` has no way to map the selected
      // value back to its label and renders the raw value — so a select showed
      // "decimal" where the list said "Decimal degrees".
      items={options}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'border-input bg-background flex h-9 items-center justify-between gap-2 rounded-md',
          'border px-3 text-sm transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <BaseSelect.Value />
        <BaseSelect.Icon>
          <ChevronsUpDownIcon className="text-muted-foreground size-3.5" aria-hidden />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} className="z-50">
          <BaseSelect.Popup
            className={cn(
              'bg-popover text-popover-foreground border-border min-w-(--anchor-width)',
              'overflow-hidden rounded-md border p-1 shadow-lg',
            )}
          >
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className={cn(
                    'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                    'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
                  )}
                >
                  <BaseSelect.ItemIndicator className="flex size-3.5 items-center justify-center">
                    <CheckIcon className="size-3.5" aria-hidden />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
