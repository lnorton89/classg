/**
 * Query definitions, co-located so the WebSocket layer can write into exactly the
 * same cache keys the views read from. `queryOptions()` carries the data type on
 * the key, which is what makes `setQueryData` type-safe.
 */
import { queryOptions } from '@tanstack/react-query'

import { api } from './client'
import type { DetectionsQuery, TracksQuery } from './types'

export const queryKeys = {
  health: ['health'] as const,
  sensors: ['sensors'] as const,
  monitoring: ['monitoring'] as const,
  tracks: (query: TracksQuery = {}) => ['tracks', 'list', query] as const,
  track: (trackId: string) => ['tracks', 'detail', trackId] as const,
  trackDetections: (trackId: string) => ['tracks', 'detections', trackId] as const,
  detections: (query: DetectionsQuery = {}) => ['detections', query] as const,
  captures: ['captures'] as const,
  capture: (id: string) => ['captures', 'detail', id] as const,
  captureReport: (id: string) => ['captures', 'report', id] as const,
  channelPlan: ['config', 'channels'] as const,
  weights: ['config', 'weights'] as const,
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

export const trackQuery = (trackId: string) =>
  queryOptions({
    queryKey: queryKeys.track(trackId),
    queryFn: () => api.track(trackId),
    staleTime: 5_000,
  })

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
export const adsbDetectionsQuery = () =>
  queryOptions({
    queryKey: queryKeys.detections({ class: ['D'], limit: 200 }),
    queryFn: () => api.detections({ class: ['D'], limit: 200 }),
    staleTime: Infinity,
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
