import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * A keyboard key. Rendered as `<kbd>` so a screen reader announces it as one
 * rather than as stray punctuation in the middle of a sentence.
 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'border-border bg-muted text-muted-foreground inline-flex h-5 min-w-5 items-center',
        'justify-center rounded border px-1.5 font-sans text-2xs font-medium',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** True on Apple platforms, where the palette key is ⌘ rather than Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent)
}
