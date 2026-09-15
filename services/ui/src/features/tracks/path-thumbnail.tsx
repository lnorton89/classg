/**
 * The shape of a flight, at row size.
 *
 * This is the column that replaced the raw lat/lon pair — nobody recognises a
 * flight from six decimal places, and the coordinate moved into this cell's
 * tooltip where it is still available for a report.
 */
import { useFormat } from '@/app/use-format'
import { Tooltip } from '@/components/ui/tooltip'
import type { ReceiverPosition, Track } from '@/lib/api/types'
import { cn } from '@/lib/cn'

import { flightPositions } from './flight-metrics'
import { polylinePoints, projectPath, simplifyPath } from './path-shape'

const WIDTH = 72
const HEIGHT = 28
const PADDING = 3
/** Past this the extra points are sub-pixel. See simplifyPath. */
const MAX_POINTS = 64

export function PathThumbnail({
  track,
  receiver,
  className,
}: {
  track: Track
  receiver: ReceiverPosition | null
  className?: string
}) {
  const format = useFormat()
  const positions = flightPositions(track)
  const shape = projectPath(simplifyPath(positions, MAX_POINTS), {
    width: WIDTH,
    height: HEIGHT,
    padding: PADDING,
    receiver,
    operator: track.operator ?? null,
  })

  const last = positions[positions.length - 1]
  const coordinate = last ? format.coords(last.lat, last.lon) : null

  if (!shape) {
    return (
      <span className={cn('text-2xs', className)}>
        {coordinate ? (
          // One fix is a position, not a path. The coordinate is all there is,
          // so it is shown rather than hidden behind a tooltip on nothing.
          <Tooltip content={<span className="font-mono">{coordinate}</span>}>
            <span className="text-muted-foreground font-mono">single fix</span>
          </Tooltip>
        ) : (
          // Not a missing value: the aircraft was broadcasting without a GPS
          // fix, which is why it is absent from the map too.
          <span className="text-warn">no fix</span>
        )}
      </span>
    )
  }

  return (
    <Tooltip
      content={
        <span>
          {coordinate ? (
            <>
              <span className="font-mono">{coordinate}</span>
              <br />
            </>
          ) : null}
          {positions.length} path points
          <br />
          {receiver
            ? 'Receiver at centre — thumbnails of the same aircraft are to a comparable scale.'
            : 'Fitted to the path. Set a receiver position to compare flights by extent.'}
        </span>
      }
    >
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className={cn('text-track block overflow-visible', className)}
        role="img"
        aria-label={`Flight path, ${positions.length} points`}
      >
        {shape.receiver ? (
          <circle
            cx={shape.receiver.x}
            cy={shape.receiver.y}
            r={1.5}
            className="fill-muted-foreground"
            opacity={0.7}
          />
        ) : null}
        <polyline
          points={polylinePoints(shape.path)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {shape.operator ? (
          <circle
            cx={shape.operator.x}
            cy={shape.operator.y}
            r={2}
            className="text-operator"
            fill="currentColor"
          />
        ) : null}
      </svg>
    </Tooltip>
  )
}
