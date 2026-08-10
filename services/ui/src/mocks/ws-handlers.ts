/**
 * Mocked `WS /stream`.
 *
 * MSW intercepts WebSockets by patching the global `WebSocket` class rather than
 * through the service worker, so this works identically in the browser and in
 * Vitest. The real server connection is never opened — `server.connect()` is not
 * called — so the app is fully self-contained.
 */
import { ws } from 'msw'

import type { Position, ServerFrame, Track } from '@/lib/api/types'

import { getScenario } from './scenario'

const stream = ws.link('*/api/v1/stream')

/** Advance a track along its own heading so the map visibly moves in dev. */
function step(track: Track, seconds: number): Track {
  const current = track.current
  if (!current || track.state === 'COASTING') return { ...track, last_seen: nowIso() }

  const heading = current.track_deg ?? 0
  const speed = current.speed_mps ?? 0
  const rad = (heading * Math.PI) / 180
  const north = Math.cos(rad) * speed * seconds
  const east = Math.sin(rad) * speed * seconds
  const lat = current.lat + north / 111_320
  const lon = current.lon + east / (111_320 * Math.cos((current.lat * Math.PI) / 180))

  const next: Position = { ...current, lat, lon, at: nowIso() }
  const history = [...(track.history ?? []), next].slice(-512)

  return {
    ...track,
    last_seen: next.at ?? nowIso(),
    detection_count: track.detection_count + 1,
    current: next,
    history,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function frame(f: ServerFrame): string {
  return JSON.stringify(f)
}

export const wsHandlers = [
  stream.addEventListener('connection', ({ client }) => {
    // Local copy so the simulation does not mutate the fixtures.
    let tracks = getScenario().tracks.map((t) => ({ ...t }))
    let ticking = false

    client.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let message: { type?: string }
      try {
        message = JSON.parse(event.data) as { type?: string }
      } catch {
        return
      }
      if (message.type !== 'subscribe' || ticking) return
      ticking = true

      // Health first: it is the frame that tells the operator whether anything
      // else on screen can be trusted.
      client.send(frame({ type: 'health', ts: nowIso(), health: getScenario().health }))
      for (const track of tracks) {
        client.send(frame({ type: 'track.update', ts: nowIso(), track }))
      }
    })

    const tick = setInterval(() => {
      if (!ticking) return
      const scenario = getScenario()
      // Scenario switches take effect on the stream too, so flipping to
      // "Sensor down" in dev stops the tracks moving instead of leaving a
      // reassuring animation running over a broken sensor.
      if (scenario.tracks.length === 0) {
        if (tracks.length > 0) {
          for (const track of tracks) {
            client.send(frame({ type: 'track.closed', ts: nowIso(), track_id: track.track_id }))
          }
          tracks = []
        }
        client.send(frame({ type: 'health', ts: nowIso(), health: scenario.health }))
        return
      }
      if (tracks.length === 0) tracks = scenario.tracks.map((t) => ({ ...t }))

      tracks = tracks.map((t) => step(t, 1))
      for (const track of tracks) {
        client.send(frame({ type: 'track.update', ts: nowIso(), track }))
      }
    }, 1000)

    const health = setInterval(() => {
      client.send(frame({ type: 'health', ts: nowIso(), health: getScenario().health }))
    }, 10_000)

    // The contract requires the server to ping every 30 s; the client replies
    // with pong. Mocking it means the pong path is exercised in dev, not just
    // written and hoped for.
    const ping = setInterval(() => client.send(frame({ type: 'ping', ts: nowIso() })), 30_000)

    client.addEventListener('close', () => {
      clearInterval(tick)
      clearInterval(health)
      clearInterval(ping)
    })
  }),
]
