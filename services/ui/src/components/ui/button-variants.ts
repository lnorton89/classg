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
    // 40%, not the tailwind-default 50: on the dark theme a half-opacity
    // filled button still read as pressable -- the audit found an operator
    // (fine, an auditor) DOM-inspecting a disabled Restart to be sure. The
    // grayscale pulls the accent out so "inert" reads in colour as well as
    // brightness.
    'disabled:pointer-events-none disabled:opacity-40 disabled:grayscale-[0.5]',
    '[&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4',
  ),
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        // bg-transparent, not bg-background. `bg-background` is the PAGE
        // ground, so an "outline" button placed on anything else painted a
        // rectangle of the wrong colour instead of reading as an outline: on
        // the header (bg-card/85) and inside an Alert (bg-muted/40) most
        // visibly. It went unnoticed in the dark theme, where --background
        // (0.16) and --muted over it (~0.20) are nearly the same, and was
        // obvious in the light theme, where a near-white 0.985 chip sits on a
        // 0.95 alert — which is why the 404 button looked like a solid light
        // button on one screenshot and an outline on another. Transparent
        // inherits whatever it sits on, so it is an outline everywhere.
        // Call sites that genuinely want a fill (the map's centre-on-receiver
        // control, over tiles) set their own bg-*, which twMerge keeps.
        outline: 'border-border bg-transparent hover:bg-accent border',
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
