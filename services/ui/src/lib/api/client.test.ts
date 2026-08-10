import { describe, expect, it } from 'vitest'

import { unwrapConfigValue } from './client'

describe('unwrapConfigValue', () => {
  const plan = {
    channels: [{ channel: 6, freq_mhz: 2437, weight: 40 }],
  }

  it('unwraps the API config envelope', () => {
    expect(unwrapConfigValue({ value: plan, restart_required: false })).toEqual(plan)
  })

  it('accepts the legacy direct response shape', () => {
    expect(unwrapConfigValue(plan)).toEqual(plan)
  })
})
