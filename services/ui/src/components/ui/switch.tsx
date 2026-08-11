import { Switch as BaseSwitch } from '@base-ui/react/switch'

import { cn } from '@/lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  id?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
  className,
  ...aria
}: SwitchProps) {
  return (
    <BaseSwitch.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className={cn(
        'border-border bg-input relative inline-flex h-6 w-11 shrink-0 cursor-pointer',
        'items-center rounded-full border transition-colors',
        'data-checked:bg-primary data-checked:border-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...aria}
    >
      <BaseSwitch.Thumb
        className={cn(
          'bg-background block size-4.5 rounded-full shadow-sm transition-transform',
          'translate-x-0.75 data-checked:translate-x-5.75',
          'data-checked:bg-primary-foreground',
        )}
      />
    </BaseSwitch.Root>
  )
}
