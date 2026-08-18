/**
 * Query definitions, co-located so the WebSocket layer can write into exactly the
 * same cache keys the views read from. `queryOptions()` carries the data type on
 * the key, which is what makes `setQueryData` type-safe.
 */
import { keepPreviousData, queryOptions, type QueryClient } from '@tanstack/react-query'

import { api } from './client'
import { trackWithDetections } from './graphql'
import type { DetectionsQuery, TracksQuery } from './types'

export const queryKeys = {
  health: ['health'] as const,
  system: ['system'] as const,
  sensors: ['sensors'] as const,
  monitoring: ['monitoring'] as const,
  telemetry: (window: string) => ['telemetry', window] as const,
  tracks: (query: TracksQuery = {}) => ['tracks', 'list', query] as const,
  track: (trackId: string) => ['tracks', 'detail', trackId] as const,
  trackDetections: (trackId: string) => ['tracks', 'detections', trackId] as const,
  detections: (query: DetectionsQuery = {}) => ['detections', query] as const,
  captures: ['captures'] as const,
  authMe: ['auth', 'me'] as const,
  users: ['admin', 'users'] as const,
  sessions: ['admin', 'sessions'] as const,
  hookRules: ['admin', 'hooks'] as const,
  hookDeliveries: ['admin', 'hook-deliveries'] as const,
  deployment: ['admin', 'deployment'] as const,
  deploymentHistory: ['admin', 'deployment', 'history'] as const,
  watchdog: ['admin', 'watchdog'] as const,
  spectrumBands: ['spectrum', 'bands'] as const,
  spectrumSweeps: ['spectrum', 'sweeps'] as const,
  spectrumSweep: (id: string, bins: number) => ['spectrum', 'sweep', id, bins] as const,
  capture: (id: string) => ['captures', 'detail', id] as const,
  captureReport: (id: string) => ['captures', 'report', id] as const,
  channelPlan: ['config', 'channels'] as const,
  weights: ['config', 'weights'] as const,
  settings: ['config', 'settings'] as const,
}

/**
 * Health has a short staleTime rather than `Infinity` even though the socket
 * pushes it: if the socket itself is down, health is the one thing that must
 * still update, because "the sensor is broken" is the state we most need to
 * surface and the socket dying is correlated with the API dying.
 */
export const healthQuery = () =>
  queryOptions({
    queryKey: queryKeys.health,
    queryFn: () => api.health(),
    staleTime: 5_000,
    refetchInterval: 15_000,
  })

/**
 * Host figures move; build and runtime do not. The interval is what makes the
 * About panel a live view of the Pi rather than a snapshot of whenever it was
 * opened -- CPU temperature and load are the two an operator watches while
 * deciding whether the unit is coping. Slower than health because nothing here
 * decides whether the sky is quiet.
 */
export const systemQuery = () =>
  queryOptions({
    queryKey: queryKeys.system,
    queryFn: () => api.system(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  })

/**
 * Recorded host history for the About panel's sparklines. Refetched on the
 * sampler's own cadence (one row a minute), so the right edge stays current
 * without hammering a Pi that is possibly the thing under thermal stress.
 * `keepPreviousData` holds the old window's frame at reduced opacity while a
 * new window loads, instead of collapsing to a skeleton.
 */
export const telemetryQuery = (window: string) =>
  queryOptions({
    queryKey: queryKeys.telemetry(window),
    queryFn: () => api.telemetry({ window }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })

export const monitoringQuery = () =>
  queryOptions({
    queryKey: queryKeys.monitoring,
    queryFn: () => api.monitoring(),
    // Pushed over the socket, but polled slowly as a backstop: if the socket is
    // down, whether we are recording is exactly the thing not to be wrong about.
    staleTime: 10_000,
    refetchInterval: 30_000,
  })

export const sensorsQuery = () =>
  queryOptions({
    queryKey: queryKeys.sensors,
    queryFn: () => api.sensors(),
    staleTime: 10_000,
    // Polled on the same cadence as health. Without this the sensor cards were
    // fetched once on mount and then sat there: a sensor could go stale, or
    // recover, and the panel kept showing whatever was true when the page
    // loaded -- while the banner above it, which polls health, moved on. That
    // produced a green "Quiet sky" over a card reading "unhealthy".
    refetchInterval: 15_000,
  })

/** Active and archived tracks. Fed by the socket; refetched wholesale on reconnect. */
export const tracksQuery = (query: TracksQuery = {}) =>
  queryOptions({
    queryKey: queryKeys.tracks(query),
    queryFn: () => api.tracks(query),
    staleTime: Infinity,
  })

/**
 * The track, fetched together with its detections over the GraphQL endpoint
 * in one round trip -- see lib/api/graphql.ts for why. The detections half of
 * that response is seeded straight into `trackDetectionsQuery`'s cache entry
 * as a side effect, so the detail route's second `useQuery` finds it already
 * warm instead of firing its own REST call.
 *
 * `queryClient` is optional only so existing callers that do not need the
 * seeding (there are none today) are not forced to pass one; every real call
 * site has a client on hand and should pass it.
 */
export const trackQuery = (trackId: string, queryClient?: QueryClient) =>
  queryOptions({
    queryKey: queryKeys.track(trackId),
    queryFn: async () => {
      const { track, detections } = await trackWithDetections(trackId, 500)
      queryClient?.setQueryData(queryKeys.trackDetections(trackId), detections)
      return track
    },
    staleTime: 5_000,
  })

/**
 * REST fallback for the same data `trackQuery` now seeds via GraphQL. Kept as
 * its own query -- rather than folded away -- because it is the thing that
 * still runs if this key is ever read without `trackQuery` having populated
 * it first.
 */
export const trackDetectionsQuery = (trackId: string) =>
  queryOptions({
    queryKey: queryKeys.trackDetections(trackId),
    queryFn: () => api.trackDetections(trackId, { limit: 500 }),
    staleTime: 5_000,
  })

/**
 * Manned traffic. The contract has no dedicated ADS-B endpoint, so class D
 * detections are the source — see ui-design.md, "How manned traffic reaches the
 * map" for why this is an inference rather than a documented path.
 */
/**
 * How far back manned traffic is considered current.
 *
 * An aircraft in range reports position every few seconds, so anything that has
 * not been heard for five minutes is out of range or on the ground. It was
 * previously unbounded, which meant the panel plotted aircraft last heard
 * sixteen hours earlier alongside one heard thirty-five minutes ago and
 * presented both as traffic that is up there now.
 *
 * Five rather than one: a brief gap in the feed, or a slow dump1090, should not
 * make an aircraft flicker out of the list while it is still overhead.
 */
export const ADSB_WINDOW_MS = 5 * 60_000

/**
 * Manned traffic, bounded to the recent past.
 *
 * The key names the WINDOW, not the instant. Putting a timestamp in the key
 * would mint a new cache entry on every render and refetch constantly; `since`
 * is computed inside queryFn instead, so each fetch is fresh while the key
 * stays stable.
 *
 * staleTime is short and there is a refetch interval, because this is live
 * traffic. It used to be `Infinity`, which meant the first response was kept
 * for the life of the page.
 */
export const adsbDetectionsQuery = () =>
  queryOptions({
    queryKey: queryKeys.detections({ class: ['D'], limit: 200 }),
    queryFn: () =>
      api.detections({
        class: ['D'],
        limit: 200,
        since: new Date(Date.now() - ADSB_WINDOW_MS).toISOString(),
      }),
    staleTime: 10_000,
    refetchInterval: 20_000,
  })

/**
 * Who is logged in, and whether anyone needs to be.
 *
 * The root of the whole app: every route waits on it, because until it answers
 * there is no way to know whether to draw the app, a login form, or the
 * first-run setup screen. Refetched on window focus so a session that expired
 * while the laptop was shut is noticed on the way back rather than at the next
 * failed action.
 */
export const authMeQuery = () =>
  queryOptions({
    queryKey: queryKeys.authMe,
    queryFn: () => api.authMe(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // Never retried. A 401 is a definite answer, and retrying it three times
    // just delays the login screen.
    retry: false,
  })

export const hookRulesQuery = () =>
  queryOptions({
    queryKey: queryKeys.hookRules,
    queryFn: () => api.hookRules(),
    staleTime: 10_000,
  })

export const hookDeliveriesQuery = () =>
  queryOptions({
    queryKey: queryKeys.hookDeliveries,
    queryFn: () => api.hookDeliveries(),
    staleTime: 5_000,
    refetchInterval: 15_000,
  })

/**
 * Deployment state.
 *
 * Polled faster while a deploy is pending, because that is the only time the
 * answer changes on its own — the agent picks the request up on its own
 * schedule and the page should notice without a reload.
 */
/**
 * Past runs, newest first.
 *
 * Polled on a slow cadence and refetched when the status query says a deploy
 * just ended -- a new row appears at most once per agent tick, and the log
 * inside each row is the expensive part of the payload.
 */
export const deploymentHistoryQuery = () =>
  queryOptions({
    queryKey: queryKeys.deploymentHistory,
    queryFn: () => api.deploymentHistory(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

export const deploymentQuery = () =>
  queryOptions({
    queryKey: queryKeys.deployment,
    queryFn: () => api.deployment(),
    staleTime: 5_000,
    // Three cadences, because a deploy has three tempos. While the agent is
    // actually rebuilding -- several minutes on a Pi -- the log grows line by
    // line and somebody is watching it. While one is queued, the agent picks
    // it up within its timer interval. Otherwise nothing is happening and a
    // minute is plenty.
    refetchInterval: (query) => {
      const state = query.state.data
      if (state?.last_result === 'deploying') return 3_000
      if (state?.deploy_requested) return 10_000
      return 60_000
    },
  })

/**
 * Self-repair state.
 *
 * Polled at roughly the watchdog's own cadence. Faster would show the same
 * answer repeatedly; much slower would mean a unit that has given up on a
 * sensor sits there looking fine for minutes.
 */
export const watchdogQuery = () =>
  queryOptions({
    queryKey: queryKeys.watchdog,
    queryFn: () => api.watchdog(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

export const usersQuery = () =>
  queryOptions({
    queryKey: queryKeys.users,
    queryFn: () => api.users(),
    staleTime: 10_000,
  })

export const sessionsQuery = () =>
  queryOptions({
    queryKey: queryKeys.sessions,
    queryFn: () => api.sessions(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  })

/**
 * The band plan and whether this unit can sweep at all.
 *
 * The poll rate is decided from the response rather than from a caller-supplied
 * flag: `running_sweep_id` is in the payload, so the query can speed itself up
 * while the radio is taken and go quiet when it is not. Passing the flag in
 * instead would mean two components mounting the same key with different
 * intervals, which React Query resolves by whichever mounted first.
 */
export const spectrumBandsQuery = () =>
  queryOptions({
    queryKey: queryKeys.spectrumBands,
    queryFn: () => api.spectrumBands(),
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.running_sweep_id ? 3_000 : false),
  })

/** Same self-pacing rule: poll while any sweep is still measuring. */
export const spectrumSweepsQuery = () =>
  queryOptions({
    queryKey: queryKeys.spectrumSweeps,
    queryFn: () => api.spectrumSweeps(),
    staleTime: 10_000,
    refetchInterval: (query) =>
      query.state.data?.sweeps.some((sweep) => sweep.state === 'running') ? 3_000 : false,
  })

/**
 * One sweep with its trace.
 *
 * A COMPLETED sweep is a measurement of one moment and will never change, so it
 * is cached forever. A RUNNING one has no trace yet, and caching that forever
 * is the bug this shape exists to prevent: the panel selects a sweep the
 * instant it is started, fetches a record with no measurement in it, and with
 * a flat `staleTime: Infinity` never fetched again -- so the chart stayed empty
 * after the sweep finished and only a page reload fixed it.
 *
 * The live stream now pushes sweep.status and invalidates this key, which makes
 * the update instant. The polling here is the backstop for the case where that
 * cannot arrive: the socket is down, and the socket being down is exactly when
 * a page that waits for a push waits forever.
 */
const sweepIsSettled = (state: string | undefined) =>
  state === 'completed' || state === 'failed'

export const spectrumSweepQuery = (sweepId: string, bins: number) =>
  queryOptions({
    queryKey: queryKeys.spectrumSweep(sweepId, bins),
    queryFn: () => api.spectrumSweep(sweepId, bins),
    staleTime: (query) => (sweepIsSettled(query.state.data?.state) ? Infinity : 0),
    refetchInterval: (query) => (sweepIsSettled(query.state.data?.state) ? false : 2_000),
  })

export const capturesQuery = () =>
  queryOptions({
    queryKey: queryKeys.captures,
    queryFn: () => api.captures(),
    staleTime: 5_000,
  })

export const captureQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.capture(id),
    queryFn: () => api.capture(id),
    staleTime: 5_000,
  })

export const captureReportQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.captureReport(id),
    queryFn: () => api.captureReport(id),
    staleTime: Infinity,
    retry: false,
  })

export const channelPlanQuery = () =>
  queryOptions({
    queryKey: queryKeys.channelPlan,
    queryFn: () => api.channelPlan(),
    staleTime: 60_000,
  })

export const weightsQuery = () =>
  queryOptions({
    queryKey: queryKeys.weights,
    queryFn: () => api.weights(),
    staleTime: 60_000,
  })

export const settingsQuery = () =>
  queryOptions({
    queryKey: queryKeys.settings,
    queryFn: () => api.settings(),
    staleTime: 60_000,
  })
