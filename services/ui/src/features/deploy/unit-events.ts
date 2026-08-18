/**
 * What the unit did to itself, as log entries.
 *
 * Deploys and watchdog repairs are the two things that happen on this box
 * without anybody in a browser asking for them, and until now neither said
 * anything: a deploy landed, the console silently reloaded onto a new build,
 * and the only record was a state file somebody had to go and look at.
 *
 * They have no stream frame to ride on, and deliberately so -- the API cannot
 * see them happen either. It reads the agents' state files, so a transition is
 * something a POLL notices rather than something anybody pushes. That makes
 * this a state-difference watcher, which is a shape worth keeping honest:
 *
 *   - the FIRST reading is never an event. A page opened while a deploy is
 *     already running has not just witnessed it start, and announcing it as
 *     news would fire a "deploying" line on every page load during a deploy.
 *   - only transitions are logged, never states. `last_result` sits at
 *     "deployed" for hours; the interesting instant is when it becomes that.
 *
 * Both rules live in the pure reducer below, which is what the tests exercise.
 */
import type { DeploymentStatus, WatchdogStatus } from '@/lib/api/types'
import type { LogEntry, LogLevel } from '@/features/logs/log-store'

export interface UnitEvent {
  level: LogLevel
  message: string
  detail?: LogEntry['detail']
}

/** What we remember between polls. Everything needed to spot a transition. */
export interface UnitMemo {
  deployResult?: string
  deployCommit?: string
  watchdogActions?: number
  needsHands?: string
}

export function deploymentEvents(
  previous: UnitMemo,
  status: DeploymentStatus | undefined,
): { events: UnitEvent[]; memo: UnitMemo } {
  if (!status?.configured) return { events: [], memo: previous }

  const memo: UnitMemo = {
    ...previous,
    deployResult: status.last_result,
    deployCommit: status.commit,
  }
  // First sighting: remember it, announce nothing.
  if (previous.deployResult === undefined) return { events: [], memo }

  const events: UnitEvent[] = []

  if (status.last_result !== previous.deployResult) {
    switch (status.last_result) {
      case 'deploying':
        events.push({
          level: 'info',
          message: 'Deploy started on the unit — services restart as it goes',
          detail: { from: previous.deployCommit?.slice(0, 8) },
        })
        break
      case 'deployed':
        events.push({
          level: 'info',
          message: `Deployed ${(status.commit ?? '').slice(0, 8)}`,
          detail: {
            subject: status.commit_subject,
            ok: status.last_deploy_ok,
          },
        })
        break
      case 'rebuilt':
        events.push({
          level: 'info',
          message: 'Rebuilt a stale build artefact; the tree was already current',
          detail: { reason: status.last_reason },
        })
        break
      case 'failed':
        events.push({
          level: 'error',
          message: 'Deploy failed on the unit',
          detail: { reason: status.last_reason },
        })
        break
      // "blocked" is the resting state of a unit waiting for CI, and it
      // alternates with "up-to-date" all day. Logging it would be noise
      // wearing the clothes of an event.
      default:
        break
    }
  }

  return { events, memo }
}

export function watchdogEvents(
  previous: UnitMemo,
  status: WatchdogStatus | undefined,
): { events: UnitEvent[]; memo: UnitMemo } {
  if (!status?.configured) return { events: [], memo: previous }

  const memo: UnitMemo = {
    ...previous,
    watchdogActions: status.actions_taken,
    needsHands: status.needs_hands,
  }
  if (previous.watchdogActions === undefined) return { events: [], memo }

  const events: UnitEvent[] = []

  // A repair is the watchdog doing its job, and it is also evidence that
  // something needed repairing -- which is the part worth surfacing.
  if (status.actions_taken > (previous.watchdogActions ?? 0)) {
    const made = status.actions_taken - (previous.watchdogActions ?? 0)
    events.push({
      level: 'warn',
      message: `The watchdog repaired something (${made} action${made === 1 ? '' : 's'})`,
      // The log is an array and the entry's detail is scalar-valued, which is
      // deliberate on the store's side: a chip renders a value, not a tree.
      detail: { last_line: status.log?.[status.log.length - 1] },
    })
  }

  // The one that matters most: a bounded watchdog's way of saying it has run
  // out of retries and a person has to go and look.
  if (status.needs_hands && status.needs_hands !== previous.needsHands) {
    events.push({
      level: 'error',
      message: `The watchdog has given up: ${status.needs_hands}`,
    })
  }

  return { events, memo }
}
