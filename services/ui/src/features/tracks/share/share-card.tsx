/**
 * The shareable track infographic.
 *
 * Portrait, because this is made to be sent — a phone message, a post, a page
 * in a report — and a 16:9 card arrives letterboxed in all three.
 *
 * It leads with what happened, not with the identifier. The serial is the least
 * meaningful thing on here to anyone who is not already looking at the console,
 * so it sits with the other reference fields near the bottom; the headline is
 * the finding.
 *
 * EVERY COLOUR AND FONT IS A LITERAL, never a `var(--…)` or a Tailwind class.
 * Export rasterises the card by serialising this SVG into an `<img>`, and an
 * image loaded that way has no document, so no stylesheet, no custom
 * properties, no utility classes. `var(--track)` renders correctly on screen
 * and black-on-black in the PNG — the kind of bug you find after sending
 * someone the file. Manrope is embedded as `@font-face` bytes at export time
 * for the same reason (see share-card-fonts.ts).
 *
 * Palette and lockup follow docs/planning/brand-identity.md: Night, Sensor
 * Cyan, Fog, wordmark in Manrope ExtraBold with the terminal G in cyan.
 *
 * Tone follows the rest of the UI — a record of what was received, not an
 * alert. Nothing is styled as a threat and confidence is never relabelled as
 * risk.
 */
import type { Ref } from 'react'

import { ClassGMarkGeometry } from '@/components/brand/classg-logo'
import { EMPTY } from '@/lib/format'

import type { ShareCardModel } from './share-card-model'

export const CARD_WIDTH = 1080
export const CARD_HEIGHT = 1440

/** docs/planning/brand-identity.md. Night, Sensor Cyan, Fog are fixed. */
const C = {
  night: '#061827',
  cyan: '#57c8f7',
  fog: '#f0f3f5',
  panel: '#0c2236',
  edge: '#153048',
  dim: '#8ba3b8',
  grid: '#122d44',
} as const

const SANS = "'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

const PAD = 72
const INNER = CARD_WIDTH - PAD * 2

/** Long identifiers must not run off the card; step the size down instead. */
function fitSize(text: string, base: number, perChar: number, max: number): number {
  const estimated = max / Math.max(1, text.length) / perChar
  return Math.max(18, Math.min(base, estimated))
}

function Label({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text
      x={x}
      y={y}
      fontFamily={SANS}
      fontSize="19"
      fontWeight="700"
      fill={C.dim}
      letterSpacing="0.16em"
    >
      {children.toUpperCase()}
    </text>
  )
}

/** The ClassG mark, positioned on the card. Geometry is shared with the live
 *  header logo — see ClassGMarkGeometry's own comment for why the colours
 *  are not. */
function Mark({ x, y, size }: { x: number; y: number; size: number }) {
  const s = size / 160
  return (
    <g transform={`translate(${x}, ${y}) scale(${s})`}>
      <ClassGMarkGeometry
        colors={{ plateFill: C.night, plateStroke: C.cyan, cyan: C.cyan, fog: C.fog }}
      />
    </g>
  )
}

function Stat({ x, y, label, value }: { x: number; y: number; label: string; value: string }) {
  return (
    <>
      <text x={x} y={y} fontFamily={SANS} fontSize="42" fontWeight="800" fill={C.fog}>
        {value}
      </text>
      <text
        x={x}
        y={y + 28}
        fontFamily={SANS}
        fontSize="17"
        fontWeight="700"
        fill={C.dim}
        letterSpacing="0.13em"
      >
        {label.toUpperCase()}
      </text>
    </>
  )
}

function Row({
  x,
  y,
  width,
  label,
  value,
  mono = false,
}: {
  x: number
  y: number
  width: number
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <>
      <text x={x} y={y} fontFamily={SANS} fontSize="21" fontWeight="600" fill={C.dim}>
        {label}
      </text>
      <text
        x={x + width}
        y={y}
        textAnchor="end"
        fontFamily={mono ? MONO : SANS}
        fontSize={mono ? fitSize(value, 22, 0.62, width * 0.72) : 22}
        fontWeight="600"
        fill={C.fog}
      >
        {value}
      </text>
      <line x1={x} x2={x + width} y1={y + 16} y2={y + 16} stroke={C.edge} strokeWidth="1" />
    </>
  )
}

/**
 * Signal strength over time.
 *
 * Explicitly captioned, because an unlabelled trace on a shared card is a
 * Rorschach test. RSSI is a proxy for distance and nothing more — the
 * calibration record puts a Mini 5 Pro at about -35 dBm at 10 m — so it is
 * labelled in dBm and never converted into a range in metres.
 */
function SignalPlot({
  model,
  x,
  y,
  w,
  h,
}: {
  model: ShareCardModel
  x: number
  y: number
  w: number
  h: number
}) {
  const signal = model.signal
  const plotTop = y + 44
  const plotH = h - 78

  return (
    <g>
      <Label x={x} y={y + 8}>
        Signal strength
      </Label>
      <text
        x={x + w}
        y={y + 8}
        textAnchor="end"
        fontFamily={SANS}
        fontSize="19"
        fontWeight="600"
        fill={C.dim}
      >
        {signal ? `${signal.maxRssi} to ${signal.minRssi} dBm` : ''}
      </text>

      {!signal ? (
        <text
          x={x + w / 2}
          y={plotTop + plotH / 2}
          textAnchor="middle"
          fontFamily={SANS}
          fontSize="21"
          fill={C.dim}
        >
          No signal-strength samples recorded
        </text>
      ) : (
        <>
          {[0, 0.5, 1].map((t) => (
            <line
              key={t}
              x1={x}
              x2={x + w}
              y1={plotTop + plotH * t}
              y2={plotTop + plotH * t}
              stroke={C.grid}
              strokeWidth="1"
            />
          ))}
          <polyline
            points={signal.points
              .map((p) => `${(x + p.x * w).toFixed(1)},${(plotTop + p.y * plotH).toFixed(1)}`)
              .join(' ')}
            fill="none"
            stroke={C.cyan}
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <text x={x} y={y + h - 6} fontFamily={SANS} fontSize="18" fill={C.dim}>
            Higher is a stronger signal — a rough proxy for how close it was, not a range.
          </text>
        </>
      )}
    </g>
  )
}

export function ShareCard({
  model,
  ref,
}: {
  model: ShareCardModel
  /** Export reads the live element, so the caller needs a handle on it. */
  ref?: Ref<SVGSVGElement>
}) {
  const confidence = Math.max(0, Math.min(1, model.confidence))
  const headline = model.headline

  const summary =
    `ClassG detection record. ${headline}. Confidence ${model.confidenceLabel}. ` +
    `${String(model.detectionCount)} detections over ${model.durationLabel}.` +
    (model.redacted ? ' Location withheld.' : '')

  const barY = 706
  const barW = INNER

  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`}
      // The attributes give the serialised copy its intrinsic size, so the
      // exported PNG is full resolution however small the preview was. The
      // class scales it on screen and means nothing once serialised, so the two
      // never fight.
      width={CARD_WIDTH}
      height={CARD_HEIGHT}
      className="h-auto w-full"
      role="img"
      aria-label={summary}
    >
      <rect width={CARD_WIDTH} height={CARD_HEIGHT} fill={C.night} />
      <rect x="0" y="0" width={CARD_WIDTH} height="8" fill={C.cyan} />

      {/* Lockup */}
      <Mark x={PAD} y={70} size={76} />
      <text x={PAD + 96} y={122} fontFamily={SANS} fontSize="46" fontWeight="800" fill={C.fog}>
        Class
        <tspan fill={C.cyan}>G</tspan>
      </text>
      <text
        x={CARD_WIDTH - PAD}
        y={122}
        textAnchor="end"
        fontFamily={SANS}
        fontSize="19"
        fontWeight="700"
        fill={C.dim}
        letterSpacing="0.16em"
      >
        DETECTION RECORD
      </text>

      <line x1={PAD} y1="200" x2={CARD_WIDTH - PAD} y2="200" stroke={C.edge} strokeWidth="1" />

      {/* Headline: the finding, not the identifier. */}
      <Label x={PAD} y={268}>
        Detected
      </Label>
      <text
        x={PAD}
        y={352}
        fontFamily={SANS}
        fontSize={fitSize(headline, 76, 0.56, INNER)}
        fontWeight="800"
        fill={C.fog}
      >
        {headline}
      </text>

      <g>
        {[model.state, ...(model.modelHint !== EMPTY ? [model.modelHint] : [])].map(
          (chip, i) => (
            <g key={chip} transform={`translate(${PAD + i * 200}, 386)`}>
              <rect width="184" height="44" rx="22" fill={C.panel} stroke={C.edge} />
              <text
                x="92"
                y="29"
                textAnchor="middle"
                fontFamily={SANS}
                fontSize="20"
                fontWeight="600"
                fill={C.dim}
              >
                {chip}
              </text>
            </g>
          ),
        )}
      </g>

      {/* Stats */}
      <Stat x={PAD} y={520} label="Detections" value={String(model.detectionCount)} />
      <Stat x={PAD + 320} y={520} label="Duration" value={model.durationLabel} />
      <Stat x={PAD + 620} y={520} label="Peak signal" value={model.peakRssiLabel} />

      {/* Confidence */}
      <Label x={PAD} y={640}>
        Confidence this is a drone
      </Label>
      <text x={PAD} y={694} fontFamily={SANS} fontSize="60" fontWeight="800" fill={C.fog}>
        {model.confidenceLabel}
      </text>
      <rect x={PAD} y={barY} width={barW} height="12" rx="6" fill={C.panel} />
      <rect
        x={PAD}
        y={barY}
        width={Math.max(6, barW * confidence)}
        height="12"
        rx="6"
        fill={C.cyan}
      />
      <text x={PAD} y={barY + 44} fontFamily={SANS} fontSize="20" fill={C.dim}>
        {model.evidenceClasses.length
          ? `Class ${model.evidenceClasses.join(', ')} evidence · ${model.sensorKinds.join(', ')}`
          : 'No classified evidence'}
      </text>

      <SignalPlot model={model} x={PAD} y={812} w={INNER} h={240} />

      {/* Reference fields. The serial lives here, not in the headline. */}
      <Row x={PAD} y={1108} width={INNER} label="Seen" value={model.seenLabel} />
      <Row
        x={PAD}
        y={1158}
        width={INNER}
        label="Position"
        value={model.coordinates ?? (model.redacted ? 'Withheld' : 'Not reported')}
        mono={Boolean(model.coordinates)}
      />
      <Row
        x={PAD}
        y={1208}
        width={INNER}
        label="Height AGL"
        value={model.heightAglM === null ? EMPTY : `${model.heightAglM.toFixed(0)} m`}
      />
      <Row x={PAD} y={1258} width={INNER} label="Ground track" value={model.movementLabel} />
      <Row x={PAD} y={1308} width={INNER} label="Serial" value={model.title} mono />

      {/* Footer */}
      <text x={PAD} y={1360} fontFamily={SANS} fontSize="19" fill={C.dim}>
        Received passively. ClassG never transmits, and this is not a threat assessment.
      </text>
      <text x={PAD} y={1390} fontFamily={MONO} fontSize="17" fill={C.dim} opacity="0.75">
        {model.trackId}
      </text>
    </svg>
  )
}
