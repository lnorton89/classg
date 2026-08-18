import { describe, expect, it } from 'vitest'

import { deploymentEvents, watchdogEvents } from './unit-events'
import type { UnitMemo } from './unit-events'
import type { DeploymentStatus, WatchdogStatus } from '@/lib/api/types'

function deployment(over: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    configured: true,
    update_available: false,
    deploy_requested: false,
    last_result: 'up-to-date',
    commit: 'abcdef1234567890',
    ...over,
  }
}

function watchdog(over: Partial<WatchdogStatus> = {}): WatchdogStatus {
  return {
    configured: true,
    actions_taken: 0,
    api_healthy: true,
    wifi_adapter_present: true,
    sdr_present: true,
    ...over,
  }
}

describe('deploymentEvents', () => {
  // Opening a page during a deploy is not witnessing it start. Without this
  // rule every page load during a rebuild would announce one.
  it('says nothing on the first reading', () => {
    const { events, memo } = deploymentEvents({}, deployment({ last_result: 'deploying' }))
    expect(events).toEqual([])
    expect(memo.deployResult).toBe('deploying')
  })

  it('announces a deploy starting and landing', () => {
    let memo: UnitMemo = deploymentEvents({}, deployment()).memo

    const started = deploymentEvents(memo, deployment({ last_result: 'deploying' }))
    expect(started.events).toHaveLength(1)
    expect(started.events[0]?.message).toMatch(/started/i)
    memo = started.memo

    const landed = deploymentEvents(
      memo,
      deployment({ last_result: 'deployed', commit: 'fedcba9876543210' }),
    )
    expect(landed.events[0]?.message).toContain('fedcba98')
  })

  it('reports a failure as an error', () => {
    const memo = deploymentEvents({}, deployment()).memo
    const { events } = deploymentEvents(
      memo,
      deployment({ last_result: 'failed', last_reason: 'cargo build failed' }),
    )
    expect(events[0]).toMatchObject({ level: 'error' })
  })

  // "blocked" alternates with "up-to-date" all day on a unit waiting for CI.
  // Logging it would be noise wearing the clothes of an event.
  it('stays quiet about blocked and up-to-date', () => {
    const memo = deploymentEvents({}, deployment({ last_result: 'blocked' })).memo
    expect(deploymentEvents(memo, deployment({ last_result: 'up-to-date' })).events).toEqual([])
    const memo2 = deploymentEvents({}, deployment({ last_result: 'up-to-date' })).memo
    expect(deploymentEvents(memo2, deployment({ last_result: 'blocked' })).events).toEqual([])
  })

  it('says nothing on a unit with no agent', () => {
    expect(deploymentEvents({}, deployment({ configured: false })).events).toEqual([])
  })

  it('does not repeat itself while the state holds', () => {
    const memo = deploymentEvents({}, deployment()).memo
    const first = deploymentEvents(memo, deployment({ last_result: 'deployed' }))
    expect(first.events).toHaveLength(1)
    expect(
      deploymentEvents(first.memo, deployment({ last_result: 'deployed' })).events,
    ).toEqual([])
  })
})

describe('watchdogEvents', () => {
  it('announces a repair when the count moves', () => {
    const memo = watchdogEvents({}, watchdog()).memo
    const { events } = watchdogEvents(memo, watchdog({ actions_taken: 2 }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ level: 'warn' })
    expect(events[0]?.message).toContain('2 actions')
  })

  // The most important line this watcher can produce: a bounded watchdog
  // saying it has run out of retries and a person has to go and look.
  it('reports needs_hands as an error, once', () => {
    const memo = watchdogEvents({}, watchdog()).memo
    const first = watchdogEvents(memo, watchdog({ needs_hands: 'wifi adapter absent' }))
    expect(first.events[0]).toMatchObject({ level: 'error' })
    expect(
      watchdogEvents(first.memo, watchdog({ needs_hands: 'wifi adapter absent' })).events,
    ).toEqual([])
  })

  it('says nothing on the first reading', () => {
    expect(watchdogEvents({}, watchdog({ actions_taken: 7 })).events).toEqual([])
  })
})
