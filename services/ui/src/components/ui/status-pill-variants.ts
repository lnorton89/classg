/**
 * The status tone palette, kept out of status-pill.tsx for the same reason
 * button-variants.ts is kept out of button.tsx: a module that exports a
 * component alongside anything else cannot be hot-swapped by Fast Refresh.
 *
 * It is also imported by the header's status button, which draws a pill as a
 * `<button>` rather than a `<span>` and so cannot use the component — but must
 * not therefore own a second copy of the palette, which is exactly how the
 * header's tones came to drift from everything else's.
 */
import { cva } from 'class-variance-authority'

/**
 * Five tones, and no more, because a sixth would have to mean something:
 *
 *   ok      working, and that is evidence
 *   warn    working, but do not trust it without reading the reason
 *   down    not working
 *   info    a state worth naming that is neither good nor bad
 *   muted   off, absent, or not applicable
 *
 * Deliberately NOT a severity ramp an operator could read as a threat level:
 * these describe the *instrument*, never the aircraft. Confidence keeps its
 * single hue — see styles.css.
 */
export type StatusPillTone = 'ok' | 'warn' | 'down' | 'info' | 'muted'

export const statusPill = cva('inline-flex items-center border font-medium whitespace-nowrap', {
  variants: {
    tone: {
      ok: 'border-ok/35 bg-ok/15 text-ok',
      warn: 'border-warn/35 bg-warn/15 text-warn',
      down: 'border-down/40 bg-down/15 text-down',
      info: 'border-primary/35 bg-primary/10 text-primary',
      muted: 'border-transparent bg-muted text-muted-foreground',
    },
    size: {
      sm: 'gap-1 rounded-md px-1.5 py-0.5 text-2xs',
      // `md` reproduces the old Badge geometry exactly, so migrating a call
      // site changed the vocabulary and not the layout of the row it sits in.
      md: 'gap-1 rounded-md px-1.5 py-0.5 text-xs',
      // The header's own size: a taller, fully-round pill that reads as a
      // control rather than as an annotation on a row.
      lg: 'h-8 shrink-0 gap-1.5 rounded-full pr-2.5 pl-2 text-xs',
    },
    interactive: { true: 'transition-colors', false: '' },
  },
  compoundVariants: [
    { tone: 'ok', interactive: true, class: 'hover:bg-ok/25' },
    { tone: 'warn', interactive: true, class: 'hover:bg-warn/25' },
    { tone: 'down', interactive: true, class: 'hover:bg-down/25' },
    { tone: 'info', interactive: true, class: 'hover:bg-primary/20' },
    { tone: 'muted', interactive: true, class: 'hover:bg-muted/70' },
  ],
  defaultVariants: { tone: 'muted', size: 'md', interactive: false },
})

/**
 * Dot colours, for the one caller that draws its dot outside the pill
 * component. `bg-current` is preferred wherever the dot is a child of the pill
 * itself — it cannot drift out of step with the tone.
 */
export const STATUS_DOT: Record<StatusPillTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  down: 'bg-down',
  info: 'bg-primary',
  muted: 'bg-muted-foreground',
}
