/**
 * Laying tracks out as an NVR-style event timeline.
 *
 * A track is an interval — it was present from first_seen to last_seen — which
 * is the same shape as a motion event on a security recorder, and it gets the
 * same treatment: one bar per event, packed into as few rows as will hold them
 * without overlap.
 *
 * Everything here is pure so the packing can be tested without a DOM. The
 * drawing lives in event-timeline.tsx and does no arithmetic beyond scaling.
 */
import type { Track } from '@/lib/api/types'

export interface TimelineWindow {
  /** Epoch ms, inclusive. */
  startMs: number
  /** Epoch ms, exclusive. */
  endMs: number
}

export interface TimelineEvent {
  track: Track
  /** Where the bar starts, clamped into the window. */
  fromMs: number
  /** Where it ends, clamped into the window. */
  toMs: number
  /** True when the track began before the window and the bar is cut off. */
  clippedStart: boolean
  /** True when it ran past the window's end. */
  clippedEnd: boolean
  lane: number
}

/** A minute of wall time, so a single-frame track is still a visible bar. */
export const MIN_EVENT_MS = 60_000

/**
 * Pack tracks into lanes.
 *
 * Greedy by start time: each event goes in the first lane whose last bar ended
 * before this one starts. That is the classic interval-partitioning result — it
 * uses exactly as many lanes as the maximum number of tracks that overlap at
 * any instant, which is also the number an operator would count by eye.
 *
 * A gap is enforced between neighbours in a lane. Two bars that merely touch
 * render as one continuous bar, which reads as a single aircraft present the
 * whole time rather than two that arrived one after the other — the exact
 * misreading this view exists to prevent.
 */
export function packLanes(
  tracks: Track[],
  window: TimelineWindow,
  gapMs = MIN_EVENT_MS,
): TimelineEvent[] {
  const events: TimelineEvent[] = []

  const ordered = tracks
    .map((track) => {
      const first = Date.parse(track.first_seen)
      const last = Date.parse(track.last_seen)
      return { track, first, last }
    })
    // An unparseable timestamp is dropped rather than clamped to the epoch,
    // which would draw a bar across the entire window.
    .filter(({ first, last }) => Number.isFinite(first) && Number.isFinite(last))
    .filter(({ first, last }) => last >= window.startMs && first < window.endMs)
    .sort((a, b) => a.first - b.first || a.last - b.last)

  const laneEnds: number[] = []

  for (const { track, first, last } of ordered) {
    const fromMs = Math.max(first, window.startMs)
    // A track that is still open has last_seen in the past by however long the
    // sensor has been quiet; the bar ends where the evidence ends, not at
    // "now". Widening it to the present would draw an aircraft that has not
    // been heard from in ten minutes as still overhead.
    const toMs = Math.min(Math.max(last, fromMs + MIN_EVENT_MS), window.endMs)

    let lane = laneEnds.findIndex((end) => end + gapMs <= fromMs)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(toMs)
    } else {
      laneEnds[lane] = toMs
    }

    events.push({
      track,
      fromMs,
      toMs,
      clippedStart: first < window.startMs,
      clippedEnd: last > window.endMs,
      lane,
    })
  }

  return events
}

/** How many lanes a packing needs. Zero events is zero lanes, not one. */
export function laneCount(events: TimelineEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.lane + 1), 0)
}

/**
 * Tick positions for the axis, on a round interval that yields a readable
 * number of labels whatever the window length.
 */
export function ticks(window: TimelineWindow, target = 6): number[] {
  const span = window.endMs - window.startMs
  if (span <= 0) return []

  const MINUTE = 60_000
  const COARSEST = 7 * 24 * 60 * MINUTE
  const candidates = [
    MINUTE,
    5 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    60 * MINUTE,
    3 * 60 * MINUTE,
    6 * 60 * MINUTE,
    12 * 60 * MINUTE,
    24 * 60 * MINUTE,
    COARSEST,
  ]
  // A window longer than the coarsest candidate gets more labels than asked
  // for rather than none, which is the better failure.
  const step = candidates.find((c) => span / c <= target) ?? COARSEST

  const out: number[] = []
  // Anchored to the epoch rather than to the window start, so the labels land
  // on wall-clock boundaries -- 14:00, not 14:07 -- as the window slides.
  for (let t = Math.ceil(window.startMs / step) * step; t < window.endMs; t += step) {
    out.push(t)
  }
  return out
}

/** Fraction across the window, clamped. */
export function fractionAt(window: TimelineWindow, ms: number): number {
  const span = window.endMs - window.startMs
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (ms - window.startMs) / span))
}

/** The inverse, for turning a pointer position back into a time. */
export function timeAt(window: TimelineWindow, fraction: number): number {
  const span = window.endMs - window.startMs
  return window.startMs + Math.min(1, Math.max(0, fraction)) * span
}
