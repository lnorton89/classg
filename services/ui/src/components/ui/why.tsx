/**
 * "Why?" — the rationale, folded away.
 *
 * This console explains itself, and that is the right instinct: an operator
 * who does not know that zero detections from a healthy sensor is a quiet sky
 * will misread the screen. But the explanation is read once and the screen is
 * read every day, so leaving it inline costs a paragraph of vertical space on
 * every visit for a sentence nobody is still reading by the third.
 *
 * `<details>` rather than a popover, because the browser already gets the
 * keyboard handling, the ARIA expanded state and the find-in-page behaviour
 * right, and because the disclosure has to survive with JavaScript mid-load.
 */
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'

export function Why({
  label = 'Why?',
  children,
  className,
  ...props
}: Omit<ComponentProps<'details'>, 'children'> & {
  /** Override for a question the page states more precisely than "Why?". */
  label?: ReactNode
  children: ReactNode
}) {
  return (
    <details className={cn('group min-w-0', className)} {...props}>
      <summary
        className={cn(
          'text-muted-foreground hover:text-foreground inline-flex cursor-pointer',
          'list-none items-center gap-1 rounded text-xs underline decoration-dotted',
          'underline-offset-2 transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        )}
      >
        {label}
        {/* Not an icon component: this is one glyph that has to rotate, and a
            lucide import for it would be the largest thing in the file. */}
        <span
          aria-hidden
          className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          ›
        </span>
      </summary>
      <div className="text-muted-foreground mt-1.5 max-w-3xl text-xs leading-relaxed">
        {children}
      </div>
    </details>
  )
}
