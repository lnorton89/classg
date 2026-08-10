/**
 * Mock scenarios.
 *
 * The reason this exists rather than one static fixture set: the hardest thing
 * this UI has to get right is that an empty map with a broken sensor looks
 * nothing like an empty map with healthy sensors. You cannot design that, or
 * review it, without being able to flip between the two in one click.
 *
 * Tests import `setScenario` directly. In dev, the scenario switcher in the app
 * shell POSTs to `/__mock/scenario`.
 */
import type { Health, Track } from '@/lib/api/types'

import { healthDegraded, healthDown, healthOk, healthQuietSky } from './fixtures/health'
import { NO_TRACKS, TRACKS } from './fixtures/tracks'

export type ScenarioName = 'active' | 'quiet-sky' | 'degraded' | 'down'

export interface Scenario {
  name: ScenarioName
  label: string
  description: string
  health: Health
  tracks: Track[]
}

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  active: {
    name: 'active',
    label: 'Active sky',
    description: 'All sensors healthy, four tracks including one OUI-only hint.',
    health: healthOk,
    tracks: TRACKS,
  },
  'quiet-sky': {
    name: 'quiet-sky',
    label: 'Quiet sky',
    description: 'All sensors healthy, nothing flying. The empty map is trustworthy.',
    health: healthQuietSky,
    tracks: NO_TRACKS,
  },
  degraded: {
    name: 'degraded',
    label: 'Sensor down',
    description: 'SDR missing. The map is empty for a reason that is not "no drones".',
    health: healthDegraded,
    tracks: NO_TRACKS,
  },
  down: {
    name: 'down',
    label: 'System down',
    description: 'No healthy sensors. Nothing on this screen is evidence of anything.',
    health: healthDown,
    tracks: NO_TRACKS,
  },
}

let current: ScenarioName = 'active'

export function getScenario(): Scenario {
  return SCENARIOS[current]
}

export function getScenarioName(): ScenarioName {
  return current
}

export function setScenario(name: ScenarioName): void {
  current = name
}

export function resetScenario(): void {
  current = 'active'
}
