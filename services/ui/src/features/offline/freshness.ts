/**
 * "How old is what I am looking at, and does the operator need telling?"
 *
 * A console that is installed to a home screen and precached will open, render
 * its shell and lay out an empty map whether or not the Pi is switched on. That
 * is the price of being installable, and it is the same failure `sky-state.ts`
 * was written to prevent one layer up: a screen that looks like every other
 * screen while meaning nothing.
 *
 * `computeSkyState` answers "does an empty map mean an empty sky" from sensor
 * health. This answers the question underneath it — "is any of this from now" —
 * from the transport, and it is deliberately separate because the two fail
 * independently: sensors can be perfect while the phone has walked out of range
 * of the Pi's AP, and the health that says so is itself the stale thing.
 *
 * Pure and time-injected so the thresholds are testable rather than a styling
 * accident, same as sky-state.
 */
import { formatDuration } from '@/lib/format'
import type { ConnectionState } from '@/lib/api/live'

export type FreshnessLevel =
  /** The socket is up. What is on screen is current. */
  | 'live'
  /** The socket dropped moments ago and what we hold is still recent. */
  | 'reconnecting'
  /** Nothing has arrived for long enough that the screen is now misleading. */
  | 'stale'
  /** No network at all. Nothing on screen can be current. */
  | 'offline'

export interface Freshness {
  level: FreshnessLevel
  /** ms since the newest successful read, or null if nothing ever arrived. */
  ageMs: number | null
  /**
   * Should this interrupt the operator with a banner? False for the states that
   * are normal traffic — a console that shouts on every 200 ms socket blip
   * teaches people to ignore it, and then it is not there when it matters.
   */
  announce: boolean
  title: string
  /** One sentence stating what the operator may and may not conclude. */
  detail: string
}

/**
 * Matches the sensor heartbeat threshold the health cards are read against, so
 * the two agree about when "recent" stops. Below it, a dropped socket is a blip
 * the backoff will fix before anyone finishes reading a warning about it.
 */
export const STALE_AFTER_MS = 30_000

/**
 * Failed connection attempts before a console that has never received anything
 * is called out.
 *
 * Not a stylistic threshold — it is what stops the banner strobing. A stream
 * that cannot reach the API cycles `connecting → reconnecting → connecting`
 * several times a second at the start of the backoff (`LiveStream.open` picks
 * the state from `everConnected`), so keying the message off the instantaneous
 * state makes it appear and vanish on every retry. The attempt counter only
 * goes up, so it does not.
 */
export const ATTEMPTS_BEFORE_ANNOUNCING = 2

export interface FreshnessInput {
  /**
   * `navigator.onLine`. True only means an interface exists — a phone attached
   * to the Pi's AP with the Pi's API down is "online" — which is exactly why
   * `connection` is the other half of this.
   */
  online: boolean
  connection: ConnectionState
  /** Pending reconnect attempt number; 0 while connected. */
  reconnectAttempt: number
  /** Epoch ms of the newest successful read of any kind. */
  lastUpdateAt: number | null
  now: number
  staleAfterMs?: number
}

function age(ms: number): string {
  return formatDuration(Math.round(ms / 1000))
}

export function computeFreshness({
  online,
  connection,
  reconnectAttempt,
  lastUpdateAt,
  now,
  staleAfterMs = STALE_AFTER_MS,
}: FreshnessInput): Freshness {
  const ageMs = lastUpdateAt === null ? null : Math.max(0, now - lastUpdateAt)

  if (!online) {
    return {
      level: 'offline',
      ageMs,
      announce: true,
      title: 'Offline — this is not the live sky',
      detail:
        ageMs === null
          ? 'This device has no network connection and nothing was received before it dropped. The map is empty because no sensor has been heard from, not because nothing is flying.'
          : `This device has no network connection. Everything on screen is frozen as it was ${age(ageMs)} ago and will not update until the connection returns.`,
    }
  }

  if (connection === 'open') {
    return {
      level: 'live',
      ageMs,
      announce: false,
      title: 'Live',
      detail: 'The stream is connected.',
    }
  }

  if (ageMs === null) {
    // A first connection still in progress is not news; the stream pill in the
    // header already says "Connecting…". One that has demonstrably failed is.
    if (reconnectAttempt < ATTEMPTS_BEFORE_ANNOUNCING) {
      return {
        level: 'reconnecting',
        ageMs,
        announce: false,
        title: 'Connecting',
        detail: 'Waiting for the first frame from the API.',
      }
    }
    return {
      level: 'stale',
      ageMs,
      announce: true,
      title: 'No data received — this screen is not a reading',
      // Deliberately not "loaded from cache": this is equally the state of a
      // console with no service worker at all, and a message that asserts a
      // cache that may not exist is the wrong thing to put on a banner whose
      // entire job is not overstating what it knows.
      detail:
        'The console is running but has not reached the API. Nothing shown here has been measured this session.',
    }
  }

  if (ageMs < staleAfterMs) {
    return {
      level: 'reconnecting',
      ageMs,
      announce: false,
      title: 'Reconnecting',
      detail: `The live stream dropped. The newest reading is ${age(ageMs)} old.`,
    }
  }

  return {
    level: 'stale',
    ageMs,
    announce: true,
    title: 'Live stream down — this screen has stopped updating',
    detail: `The newest reading is ${age(ageMs)} old. Track positions, sensor health and detection counts are all frozen at that moment, whatever the sky has done since.`,
  }
}
