import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'bg-card text-card-foreground border-border rounded-lg border shadow-xs',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-4 pb-2', className)} {...props} />
}

export function CardTitle({
  className,
  children,
  ...props
}: ComponentProps<'h3'> & { children: ReactNode }) {
  return (
    <h3 className={cn('text-sm font-semibold tracking-tight', className)} {...props}>
      {children}
    </h3>
  )
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-muted-foreground text-xs', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4 pt-2', className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-2 p-4 pt-0', className)} {...props} />
}
