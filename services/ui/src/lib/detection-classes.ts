/**
 * The detection class table, from README.md and data-model.md.
 *
 * The UI shows evidence *by class* rather than a bare confidence number, so these
 * labels are load-bearing: "Class A (Remote ID) x402" is a claim an operator can
 * check, and "94%" is not.
 */
import type { DetectionClass } from './api/types'

export interface DetectionClassInfo {
  code: DetectionClass
  /** Short label for dense contexts (table cells, map legend). */
  short: string
  /** Full name for detail views. */
  label: string
  /** What the signal actually is. */
  signal: string
  sensor: string
  /** Default noisy-OR weight from data-model.md. `null` for D, which never contributes. */
  defaultWeight: number | null
  /** Why the weight is what it is — shown as help text next to the evidence row. */
  justification: string
  /** Tailwind classes for the class chip. Hue is identity, not severity. */
  chipClass: string
}

export const DETECTION_CLASSES: Record<DetectionClass, DetectionClassInfo> = {
  A: {
    code: 'A',
    short: 'Remote ID',
    label: 'ASTM F3411 Remote ID',
    signal: 'Wi-Fi Beacon vendor IE',
    sensor: 'Wi-Fi',
    defaultWeight: 0.6,
    justification: 'Standards-compliant, self-identifying, structured.',
    chipClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  },
  B: {
    code: 'B',
    short: 'DJI DroneID',
    label: 'DJI DroneID',
    signal: 'Wi-Fi vendor IE, OUI 26:37:12',
    sensor: 'Wi-Fi',
    defaultWeight: 0.5,
    justification: 'Vendor-specific but unambiguous.',
    chipClass: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  },
  C: {
    code: 'C',
    short: 'OUI/SSID',
    label: 'Wi-Fi OUI / SSID fingerprint',
    signal: 'MAC prefix or SSID pattern',
    sensor: 'Wi-Fi',
    defaultWeight: 0.1,
    justification:
      'Weakest evidence. MAC randomisation and OUI reuse cause errors; an OUI alone is a hint, not a detection.',
    chipClass: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  },
  D: {
    code: 'D',
    short: 'ADS-B',
    label: 'ADS-B manned traffic',
    signal: '1090 MHz Mode S extended squitter',
    sensor: 'SDR',
    defaultWeight: null,
    justification:
      'Never contributes to confidence. Used for airspace context and to suppress energy-only false positives.',
    chipClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  },
  E: {
    code: 'E',
    short: 'Control link',
    label: 'Control-link cadence',
    signal: '433 / 868 / 915 MHz burst pattern',
    sensor: 'SDR',
    defaultWeight: 0.3,
    justification: 'Strong but inferential; ISM clutter is real.',
    chipClass: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  },
  F: {
    code: 'F',
    short: 'Analog FPV',
    label: 'Analog FPV video downlink',
    signal: '1.2 / 1.3 GHz carrier envelope',
    sensor: 'SDR',
    defaultWeight: 0.25,
    justification: 'Distinctive, but shares bands with other services.',
    chipClass: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  },
  G: {
    code: 'G',
    short: 'BLE Remote ID',
    label: 'ASTM F3411 Remote ID over Bluetooth LE',
    signal: 'BT4 legacy / BT5 long-range advertisement',
    sensor: 'BLE',
    defaultWeight: 0.6,
    justification: 'Same payload semantics as Class A.',
    chipClass: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  },
  H: {
    code: 'H',
    short: 'GNSS',
    label: 'GNSS interference indicator',
    signal: 'L1 noise floor elevation',
    sensor: 'SDR',
    defaultWeight: null,
    justification: 'Environmental indicator; backlog.',
    chipClass: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  },
}

export const DETECTION_CLASS_ORDER: DetectionClass[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

export function detectionClassInfo(code: DetectionClass): DetectionClassInfo {
  return DETECTION_CLASSES[code]
}

/**
 * Recompute noisy-OR from the evidence actually present, so the detail view can
 * show the arithmetic rather than asking the operator to trust a number:
 *   confidence = 1 - PROD(1 - w_i)
 */
export function noisyOr(weights: number[]): number {
  const product = weights.reduce((acc, w) => acc * (1 - w), 1)
  return Math.round((1 - product) * 1000) / 1000
}
