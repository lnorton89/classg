import { cn } from '@/lib/cn'

/**
 * Map legend.
 *
 * Present because three of the four things on the map are easy to confuse if you
 * have not read the docs: a drone, a manned aircraft, and a person standing on
 * the ground. The legend states the distinction in words, not just colour.
 */
export function MapLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'bg-card/90 border-border rounded-lg border p-2.5 text-2xs shadow-sm backdrop-blur',
        className,
      )}
    >
      <h2 className="text-muted-foreground mb-1.5 text-2xs font-semibold tracking-wide uppercase">
        Legend
      </h2>
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
      <p className="text-muted-foreground mt-2 max-w-56 border-t pt-1.5 text-2xs">
        Brightness and trail width follow <em>confidence that this is a drone</em>. Nothing here
        indicates threat or priority.
      </p>
    </div>
  )
}
