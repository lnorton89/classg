import { cva } from 'class-variance-authority'

import { cn } from '@/lib/cn'

// Kept out of button.tsx so that file exports only components: a module that
// exports a component alongside anything else cannot be hot-swapped by Fast
// Refresh, and this is imported by anything wanting a link that looks like a
// button without being one.
export const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium',
    'whitespace-nowrap transition-colors',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4',
  ),
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border-border bg-background hover:bg-accent border',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3',
        default: 'h-9 px-4',
        lg: 'h-10 px-6',
        // 44px: the field-use touch target. Do not shrink this on mobile.
        touch: 'h-11 px-5',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)
