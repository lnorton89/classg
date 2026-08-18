/**
 * When it is safe to take a new build without asking.
 *
 * The console is a single page an operator leaves open for days -- on a wall,
 * on a phone in a pocket -- so "deploy and tell them to refresh" is not an
 * update mechanism. But applying an update is a reload, and a reload is not
 * free: it returns the map to its default view, drops the current selection,
 * and interrupts whatever was being read.
 *
 * So the question is not whether to auto-apply, it is WHEN. Three answers,
 * and the middle one is the interesting one:
 *
 *   now        Nobody is looking. The tab is hidden -- backgrounded, or the
 *              phone is locked -- and a reload costs nothing at all.
 *   countdown  Somebody is looking but nothing is in flight. Apply shortly,
 *              visibly, with a way to say no. The countdown is the consent.
 *   hold       Something is running that a reload would lose or confuse.
 *              Wait, and keep the banner.
 *
 * `hold` is the one worth being strict about. A sweep has taken the radio from
 * dump1090 and is minutes from finishing; a capture is writing a file. Neither
 * survives a page reload usefully, and an update that interrupted one would be
 * the console spending the operator's ADS-B outage on itself.
 */

export type AutoApplyDecision =
  { kind: 'now' } | { kind: 'countdown'; ms: number } | { kind: 'hold'; reason: string }

export interface AutoApplyInputs {
  /** document.hidden, or its equivalent. */
  hidden: boolean
  /** A sweep is running: the radio is taken and the measurement is unfinished. */
  sweepRunning: boolean
  /** A capture is recording to disk. */
  captureRunning: boolean
  /** The operator pressed "Not now" for this build. */
  declined: boolean
}

/** Long enough to read the banner and press the button, short enough to mean it. */
export const AUTO_APPLY_COUNTDOWN_MS = 15_000

export function decideAutoApply(inputs: AutoApplyInputs): AutoApplyDecision {
  if (inputs.declined) {
    return { kind: 'hold', reason: 'you chose to keep this build for now' }
  }
  // Checked before `hidden`: a backgrounded tab whose unit is mid-sweep is
  // still mid-sweep, and the sweep is the thing that must not be interrupted.
  if (inputs.sweepRunning) {
    return { kind: 'hold', reason: 'a band sweep is running' }
  }
  if (inputs.captureRunning) {
    return { kind: 'hold', reason: 'a capture is recording' }
  }
  if (inputs.hidden) {
    return { kind: 'now' }
  }
  return { kind: 'countdown', ms: AUTO_APPLY_COUNTDOWN_MS }
}
