import { XIcon } from 'lucide-react'

import { TeachingHelpButton } from '@/components/ui/teaching-banner'
import { useTeaching } from '@/components/ui/use-teaching'
import { cn } from '@/lib/cn'

/**
 * Map legend.
 *
 * Present because three of the four things on the map are easy to confuse if you
 * have not read the docs: a drone, a manned aircraft, and a person standing on
 * the ground. The legend states the distinction in words, not just colour.
 *
 * The swatches stay. The paragraph under them does not: what brightness and
 * trail width encode is a rule learned once, and it was sitting permanently
 * over the bottom-left corner of the live map -- the part of the airspace an
 * operator is least able to get back by scrolling. It is dismissible, and the
 * "?" beside the heading brings it back.
 *
 * The same argument, one level up, applies to the whole panel: once the three
 * symbols are second nature the legend is furniture standing on the map. So it
 * closes too, down to a chip that opens it again -- taught once, then out of
 * the way, rather than a setting somebody has to go and find. (Settings › Live
 * map still turns it off entirely; that is a different question, and it is
 * what withholds this component altogether.)
 */
const LEGEND_FOOTER_TITLE = 'what brightness and trail width mean'

export function MapLegend({ className }: { className?: string }) {
  const legend = useTeaching('map-legend')
  const footer = useTeaching('map-legend-footer')

  if (legend.dismissed) {
    return (
      <button
        type="button"
        onClick={legend.show}
        aria-expanded={false}
        className={cn(
          'bg-card/90 border-border label-caps text-muted-foreground hover:text-foreground',
          'rounded-lg border px-2 py-1 shadow-sm backdrop-blur transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          className,
        )}
      >
        Legend
      </button>
    )
  }

  return (
    <div
      className={cn(
        'bg-card/90 border-border rounded-lg border p-2.5 text-2xs shadow-sm backdrop-blur',
        className,
      )}
    >
      <div className="mb-1.5 flex items-center gap-1">
        <h2 className="label-caps">Legend</h2>
        <TeachingHelpButton teaching={footer} title={LEGEND_FOOTER_TITLE} className="-my-1" />
        <button
          type="button"
          onClick={legend.dismiss}
          aria-expanded
          aria-label="Close the map legend. A Legend button reopens it."
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-accent -my-1 -mr-1 ml-auto',
            'focus-visible:ring-ring rounded p-1 transition-colors',
            'focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          <XIcon className="size-3" aria-hidden />
        </button>
      </div>
      <ul className="space-y-1.5">
        <li className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="text-track size-4" aria-hidden>
            <path d="M12 2 L19.5 21 L12 16.6 L4.5 21 Z" fill="currentColor" />
          </svg>
          <span>
            <strong className="font-medium">Drone</strong> — filled arrow, points along track
          </span>
        </li>
        <li className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="text-manned size-4" aria-hidden>
            <path
              d="M12 3 L21 20 L12 15 L3 20 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          <span>
            <strong className="font-medium">Manned aircraft</strong> — hollow, labelled MANNED
          </span>
        </li>
        <li className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="text-operator size-4" aria-hidden>
            <circle cx="12" cy="7.5" r="3.4" fill="currentColor" />
            <path d="M4.5 20.5 a7.5 7.5 0 0 1 15 0 Z" fill="currentColor" />
          </svg>
          <span>
            <strong className="font-medium">Operator</strong> — on the ground, not an aircraft
          </span>
        </li>
        <li className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="text-track size-4" aria-hidden>
            <path
              d="M2 18 C 8 18, 10 8, 22 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          <span>
            <strong className="font-medium">Trail</strong> — thicker means more corroborated
          </span>
        </li>
      </ul>
      {footer.dismissed ? null : (
        <div className="text-muted-foreground mt-2 flex max-w-56 items-start gap-1 border-t pt-1.5 text-2xs">
          <p className="min-w-0 flex-1">
            Brightness and trail width follow <em>confidence that this is a drone</em>. Nothing
            here indicates threat or priority.
          </p>
          <button
            type="button"
            onClick={footer.dismiss}
            aria-label={`Dismiss ${LEGEND_FOOTER_TITLE}. It stays available from the question mark.`}
            className={cn(
              'hover:text-foreground hover:bg-accent -mt-0.5 -mr-0.5 shrink-0 rounded p-0.5',
              'transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            )}
          >
            <XIcon className="size-3" aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}
