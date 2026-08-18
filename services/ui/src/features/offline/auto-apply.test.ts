import { describe, expect, it } from 'vitest'

import { AUTO_APPLY_COUNTDOWN_MS, decideAutoApply } from './auto-apply'
import type { AutoApplyInputs } from './auto-apply'

function inputs(over: Partial<AutoApplyInputs> = {}): AutoApplyInputs {
  return { hidden: false, sweepRunning: false, captureRunning: false, declined: false, ...over }
}

describe('decideAutoApply', () => {
  it('applies immediately when nobody is looking', () => {
    expect(decideAutoApply(inputs({ hidden: true }))).toEqual({ kind: 'now' })
  })

  it('counts down in front of somebody who is', () => {
    expect(decideAutoApply(inputs())).toEqual({
      kind: 'countdown',
      ms: AUTO_APPLY_COUNTDOWN_MS,
    })
  })

  // A reload mid-sweep spends the operator's ADS-B outage on the console
  // updating itself, and the measurement it was paid for is lost.
  it('holds while a sweep is running', () => {
    const d = decideAutoApply(inputs({ sweepRunning: true }))
    expect(d.kind).toBe('hold')
    if (d.kind === 'hold') expect(d.reason).toMatch(/sweep/i)
  })

  it('holds while a capture is recording', () => {
    expect(decideAutoApply(inputs({ captureRunning: true })).kind).toBe('hold')
  })

  // The radio does not care whether the tab is in the foreground.
  it('holds for a sweep even in a hidden tab', () => {
    expect(decideAutoApply(inputs({ hidden: true, sweepRunning: true })).kind).toBe('hold')
  })

  it('holds once the operator has said no', () => {
    expect(decideAutoApply(inputs({ declined: true })).kind).toBe('hold')
    // Including when the tab is hidden: "not now" is not "unless I look away".
    expect(decideAutoApply(inputs({ declined: true, hidden: true })).kind).toBe('hold')
  })
})
