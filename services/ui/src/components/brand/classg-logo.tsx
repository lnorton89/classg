/**
 * The ClassG lockup.
 *
 * Inline SVG rather than `<img src>` for three reasons that matter here: it
 * scales without a second asset, it can be tinted per-context, and it renders
 * on the first paint instead of after a network round trip — the header is the
 * one thing on screen while the API is still being reached.
 *
 * Geometry is kept identical to `public/brand/classg-mark.svg`, which remains
 * the source of truth for the favicon and the manifest icons.
 * See docs/planning/brand-identity.md.
 */
import { cn } from '@/lib/cn'

export type MarkSize = 'sm' | 'md' | 'lg' | 'xl'

const MARK_SIZE: Record<MarkSize, string> = {
  sm: 'size-6',
  md: 'size-8',
  lg: 'size-10',
  xl: 'size-14',
}

const WORDMARK_SIZE: Record<MarkSize, string> = {
  sm: 'text-base',
  md: 'text-xl',
  lg: 'text-2xl',
  xl: 'text-4xl',
}

export interface ClassGMarkProps {
  className?: string
  size?: MarkSize
  /**
   * The dark rounded plate the icon sits on. On for the app-icon lockup; off
   * when the mark is placed on an already-dark surface and the plate would just
   * read as a box around it.
   */
  plate?: boolean
  title?: string
}

/**
 * The geometry alone, at its native 0–160 viewBox, with every colour taken as
 * a prop instead of hardcoded.
 *
 * That split exists for one caller: `ShareCard` (features/tracks/share/)
 * draws this same mark, but into an SVG that gets serialised with
 * `XMLSerializer` and rasterised to a PNG with no stylesheet attached. A
 * `var(--color-brand-cyan)` renders correctly on screen and black in that
 * PNG — the CSS custom property has nothing to resolve against once the
 * markup is off the document. `ClassGMark` below calls this with the CSS
 * vars for a themable on-screen icon; the share card calls it with literal
 * hex from its own fixed export palette. Same geometry either way — this is
 * the one true copy the file header promises, `public/brand/classg-mark.svg`
 * aside.
 */
export interface ClassGMarkColors {
  plateFill: string
  plateStroke: string
  cyan: string
  fog: string
  fogOpacity?: number | string
}

export function ClassGMarkGeometry({
  colors,
  plate = true,
}: {
  colors: ClassGMarkColors
  plate?: boolean
}) {
  return (
    <>
      {plate ? (
        <rect
          x="1"
          y="1"
          width="158"
          height="158"
          rx="34"
          fill={colors.plateFill}
          stroke={colors.plateStroke}
          strokeOpacity="0.32"
          strokeWidth="2"
        />
      ) : null}
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* The open sensing arc that resolves into the G. */}
        <path
          d="M84 30C54 30 30 54 30 84s24 54 54 54c20 0 39-11 48-28M103 84h35l-2 10c-1 6-2 11-4 16"
          stroke={colors.cyan}
          strokeWidth="5"
        />
        {/* Inner fog arc. */}
        <path
          d="M84 45A39 39 0 1 0 115.5 107.5"
          stroke={colors.fog}
          strokeOpacity={colors.fogOpacity ?? 1}
          strokeWidth="4"
        />
      </g>
      {/* The contact: a four-node aerial glyph, never a reticle. */}
      <g stroke={colors.cyan} strokeWidth="2.25" strokeLinecap="round">
        <path d="m106 43 18 18M124 43l-18 18" />
      </g>
      <g fill={colors.cyan}>
        <circle cx="106" cy="43" r="2.7" />
        <circle cx="124" cy="43" r="2.7" />
        <circle cx="106" cy="61" r="2.7" />
        <circle cx="124" cy="61" r="2.7" />
        <circle cx="115" cy="52" r="3.2" />
      </g>
    </>
  )
}

const CSS_VAR_COLORS: ClassGMarkColors = {
  plateFill: 'var(--color-brand-night)',
  plateStroke: 'var(--color-brand-cyan)',
  cyan: 'var(--color-brand-cyan)',
  fog: 'var(--color-brand-fog)',
}

export function ClassGMark({ className, size = 'md', plate = true, title }: ClassGMarkProps) {
  return (
    <svg
      viewBox="0 0 160 160"
      className={cn(MARK_SIZE[size], 'shrink-0', className)}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <ClassGMarkGeometry
        plate={plate}
        colors={{ ...CSS_VAR_COLORS, fogOpacity: plate ? 1 : 0.85 }}
      />
    </svg>
  )
}

export function ClassGWordmark({
  className,
  size = 'md',
}: {
  className?: string
  size?: MarkSize
}) {
  return (
    <span className={cn('classg-wordmark', WORDMARK_SIZE[size], className)} aria-hidden="true">
      Class<span className="classg-wordmark__accent">G</span>
    </span>
  )
}

export interface ClassGLogoProps {
  className?: string
  size?: MarkSize
  showWordmark?: boolean
  /** The one-line positioning statement. Desktop header and splash only. */
  showTagline?: boolean
  plate?: boolean
}

export function ClassGLogo({
  className,
  size = 'md',
  showWordmark = true,
  showTagline = false,
  plate = true,
}: ClassGLogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)} aria-label="ClassG">
      <ClassGMark size={size} plate={plate} />
      {showWordmark ? (
        <span className="flex min-w-0 flex-col justify-center gap-0.5">
          <ClassGWordmark size={size} />
          {showTagline ? (
            <span className="text-muted-foreground font-display text-2xs leading-none font-semibold tracking-[0.16em] uppercase">
              Passive airspace awareness
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
