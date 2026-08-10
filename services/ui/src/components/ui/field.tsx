/**
 * Form field primitives.
 *
 * `Input`/`Label` are plain elements — a `<label for>` plus an `<input>` is
 * already the accessible pattern and wrapping it in a library adds nothing.
 * `FormField` exists so the error message is wired to the control via
 * `aria-describedby`/`aria-invalid` in one place rather than at every call site.
 */
import { useId, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/lib/cn'

export function Label({
  className,
  htmlFor,
  children,
  ...props
}: ComponentProps<'label'> & { htmlFor: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        'text-foreground text-xs font-medium',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    >
      {children}
    </label>
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'border-input bg-background h-9 w-full rounded-md border px-3 py-1 text-sm',
        'placeholder:text-muted-foreground transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30 aria-invalid:ring-2',
        className,
      )}
      {...props}
    />
  )
}

export interface FormFieldProps {
  label: string
  /** Rendered under the control; also announced via aria-describedby. */
  hint?: ReactNode
  error?: string | null
  className?: string
  children: (props: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': boolean | undefined
  }) => ReactNode
}

export function FormField({ label, hint, error, className, children }: FormFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
