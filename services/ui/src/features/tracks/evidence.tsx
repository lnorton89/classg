/**
 * Evidence display.
 *
 * "Class A (Remote ID) x402, Class B (DJI) x398" is honest in a way a bare "94%"
 * is not, so the breakdown is the primary presentation and the percentage is a
 * summary of it — never the other way round.
 *
 * Nothing here uses a red/amber/green ramp. `confidence` answers "is this really
 * a drone"; colouring it like a threat scale would restate it as one.
 */
import { Badge } from '@/components/ui/badge'
import { Tooltip } from '@/components/ui/tooltip'
import type { Evidence } from '@/lib/api/types'
import { cn } from '@/lib/cn'
import { DETECTION_CLASS_ORDER, detectionClassInfo, noisyOr } from '@/lib/detection-classes'
import { useFormat } from '@/app/use-format'

const TRACK_STATES = [
  {
    state: 'TENTATIVE',
    meaning: 'New contact; waiting for at least 2 detections spanning 2 seconds.',
  },
  {
    state: 'CONFIRMED',
    meaning: 'Corroborated contact receiving current detections.',
  },
  {
    state: 'COASTING',
    meaning: 'No detection for 30 seconds; retained in case the same aircraft returns.',
  },
  {
    state: 'CLOSED',
    meaning: 'No detection for 5 minutes; archived and removed from the active list.',
  },
] as const

function sortEvidence(evidence: Evidence[]): Evidence[] {
  return [...evidence].sort(
    (a, b) => DETECTION_CLASS_ORDER.indexOf(a.class) - DETECTION_CLASS_ORDER.indexOf(b.class),
  )
}

/** Compact chips for tables and list rows. */
export function EvidenceChips({
  evidence,
  className,
}: {
  evidence: Evidence[]
  className?: string
}) {
  if (evidence.length === 0) {
    return <span className={cn('text-muted-foreground text-2xs', className)}>no evidence</span>
  }
  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      {sortEvidence(evidence).map((item) => {
        const info = detectionClassInfo(item.class)
        return (
          <Tooltip
            key={item.class}
            content={
              <span>
                <strong>
                  Class {item.class} — {info.label}
                </strong>
                <br />
                {info.signal} · {item.count} detections via {item.sensor_kind}
                <br />
                {info.justification}
              </span>
            }
          >
            <span
              className={cn(
                'rounded border px-1 py-px font-mono text-2xs leading-tight',
                info.chipClass,
              )}
            >
              {item.class}×{item.count}
            </span>
          </Tooltip>
        )
      })}
    </span>
  )
}

/**
 * A single-hue bar. Length encodes confidence; hue is constant. Paired with a
 * numeric label everywhere it appears, so it never has to carry meaning alone.
 */
export function ConfidenceBar({
  confidence,
  className,
}: {
  confidence: number
  className?: string
}) {
  const format = useFormat()
  return (
    <span
      role="meter"
      aria-valuenow={Math.round(confidence * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Confidence that this is a drone: ${format.confidence(confidence)}`}
      className={cn('bg-muted relative block h-1.5 overflow-hidden rounded-full', className)}
    >
      <span
        className="bg-track absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${Math.round(confidence * 100)}%` }}
      />
    </span>
  )
}

/**
 * The full breakdown, including the arithmetic. Showing 1 − Π(1 − wᵢ) worked out
 * is the difference between a number an operator trusts and one they can check.
 */
export function EvidenceBreakdown({
  evidence,
  confidence,
  className,
}: {
  evidence: Evidence[]
  confidence: number
  className?: string
}) {
  const format = useFormat()
  const sorted = sortEvidence(evidence)
  const contributing = sorted.filter((e) => e.weight > 0)
  const recomputed = noisyOr(contributing.map((e) => e.weight))
  const mismatch = Math.abs(recomputed - confidence) > 0.011

  if (sorted.length === 0) {
    return (
      <p className={cn('text-muted-foreground text-sm', className)}>
        No evidence recorded for this track.
      </p>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="overflow-x-auto [scrollbar-gutter:stable]">
        <table className="mb-2 w-full min-w-[28rem] text-left text-xs">
          <caption className="sr-only">
            Evidence by detection class, with the weight each contributes to confidence
          </caption>
          <thead className="text-muted-foreground">
            <tr className="border-border border-b">
              <th scope="col" className="py-1.5 pr-2 font-medium">
                Class
              </th>
              <th scope="col" className="py-1.5 pr-2 font-medium">
                Signal
              </th>
              <th scope="col" className="py-1.5 pr-2 text-right font-medium">
                Count
              </th>
              <th scope="col" className="py-1.5 pr-2 text-right font-medium">
                Weight
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                Last seen
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {sorted.map((item) => {
              const info = detectionClassInfo(item.class)
              return (
                <tr key={item.class}>
                  <th scope="row" className="py-2 pr-2 font-normal">
                    <span
                      className={cn(
                        'rounded border px-1 py-px font-mono text-2xs',
                        info.chipClass,
                      )}
                    >
                      {item.class}
                    </span>{' '}
                    <span className="ml-1">{info.short}</span>
                  </th>
                  <td className="text-muted-foreground py-2 pr-2">
                    {info.signal}
                    <span className="block text-2xs opacity-80">via {item.sensor_kind}</span>
                  </td>
                  <td className="py-2 pr-2 text-right font-mono">{item.count}</td>
                  <td className="py-2 pr-2 text-right font-mono">
                    {item.weight === 0 ? (
                      <Tooltip content="Class D never contributes to confidence; it is used for airspace context and false-positive suppression.">
                        <span className="text-muted-foreground underline decoration-dotted">
                          n/a
                        </span>
                      </Tooltip>
                    ) : (
                      item.weight.toFixed(2)
                    )}
                  </td>
                  <td className="text-muted-foreground py-2 text-right">
                    {format.relative(item.last_seen)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="bg-muted/40 border-border rounded-md border p-3">
        <p className="text-muted-foreground text-xs">
          Confidence combines distinct evidence classes with noisy-OR, so independent weak
          signals accumulate but never quite reach certainty:
        </p>
        <p className="mt-1.5 font-mono text-xs break-words">
          1 −{' '}
          {contributing.length > 0
            ? contributing.map((e) => `(1 − ${e.weight.toFixed(2)})`).join(' × ')
            : '1'}{' '}
          = <strong>{recomputed.toFixed(3)}</strong>
        </p>
        <p className="text-muted-foreground mt-2 text-xs">
          This answers <em>“is this really a drone”</em>. It is not a threat, priority, or risk
          score, and it says nothing about position accuracy.
        </p>
        {mismatch ? (
          <p className="text-warn mt-2 text-xs">
            The API reported {format.confidence(confidence)}, which does not match the weights
            above. Fusion may be using a different weight table — check Config → Fusion weights.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** Small state badge used in tables and headers. */
export function TrackStateBadge({ state }: { state: string }) {
  const variant =
    state === 'CONFIRMED'
      ? ('ok' as const)
      : state === 'COASTING'
        ? ('warn' as const)
        : state === 'CLOSED'
          ? ('muted' as const)
          : ('default' as const)
  return (
    <Badge variant={variant} className="uppercase">
      {state.toLowerCase()}
    </Badge>
  )
}

/** The lifecycle is time-driven, so changing badges are expected and need a key. */
export function TrackStateKey() {
  return (
    <section
      aria-labelledby="track-state-key-title"
      className="border-border bg-card/50 rounded-lg border px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id="track-state-key-title" className="text-xs font-semibold">
          Track state key
        </h2>
        <p className="text-muted-foreground text-2xs">
          States advance automatically as detections arrive or stop (default timings shown).
        </p>
      </div>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {TRACK_STATES.map(({ state, meaning }) => (
          <div key={state} className="flex min-w-0 items-start gap-2">
            <dt className="shrink-0">
              <TrackStateBadge state={state} />
            </dt>
            <dd className="text-muted-foreground pt-0.5 text-2xs leading-snug">{meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
