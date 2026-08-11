import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { RecordingIndicator } from './recording-indicator'
import { RECORDING_LABEL, RECORDING_TONE, recordingState } from './recording-state'

const API = '*/api/v1'

let state = { enabled: true, since: '2026-08-11T04:00:00Z', discarded_while_paused: 0 }

const server = setupServer(
  http.get(`${API}/monitoring`, () => HttpResponse.json(state)),
  http.put(`${API}/monitoring`, async ({ request }) => {
    const body = (await request.json()) as { enabled: boolean; reason?: string }
    state = {
      ...state,
      enabled: body.enabled,
      ...(body.reason ? { reason: body.reason } : {}),
    }
    return HttpResponse.json(state)
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  state = { enabled: true, since: '2026-08-11T04:00:00Z', discarded_while_paused: 0 }
})
afterAll(() => server.close())

function renderIndicator() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <RecordingIndicator />
    </QueryClientProvider>,
  )
}

describe('RecordingIndicator', () => {
  it('shows recording without anyone having asked for it', async () => {
    renderIndicator()
    expect(await screen.findByText('Recording')).toBeInTheDocument()
  })

  it('requires confirmation before stopping', async () => {
    // Stopping a detector is the one control here whose cost is invisible
    // until you need data you did not keep, so it must not be a bare toggle.
    const user = userEvent.setup()
    renderIndicator()

    await user.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
    // Still recording: asking is not doing.
    expect(screen.getByText('Recording')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Recording')).toBeInTheDocument()
  })

  it('pauses after confirmation and offers resume', async () => {
    const user = userEvent.setup()
    renderIndicator()

    await user.click(await screen.findByRole('button', { name: 'Pause' }))
    await user.click(screen.getByRole('button', { name: 'Stop recording' }))

    expect(await screen.findByText('Paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })

  it('shows how much was discarded, so paused never looks like quiet', async () => {
    state = {
      enabled: false,
      since: '2026-08-11T04:00:00Z',
      discarded_while_paused: 1234,
    }
    renderIndicator()
    expect(await screen.findByText('Paused')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/1,234 discarded/)).toBeInTheDocument())
  })

  it('announces state changes to assistive tech', async () => {
    renderIndicator()
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Recording')
  })
})

describe('recordingState', () => {
  const on = { enabled: true, since: '', discarded_while_paused: 0 }
  const off = { enabled: false, since: '', discarded_while_paused: 0 }
  const sensor = (healthy: boolean) => ({ sensor_id: 'wifi-0', sensor_kind: 'wifi', healthy })
  const health = (...sensors: ReturnType<typeof sensor>[]) =>
    ({ status: 'ok', uptime_s: 1, version: '0', sensors }) as never

  it('is not "recording" when every sensor is unhealthy', () => {
    // The bug this exists to prevent: a green "Recording" badge next to a
    // "no sensor coverage" banner. The switch was on, so it claimed to be
    // recording while nothing could reach it.
    expect(recordingState(on, health(sensor(false)))).toBe('no-coverage')
  })

  it('is "recording" only with a healthy sensor', () => {
    expect(recordingState(on, health(sensor(true)))).toBe('recording')
  })

  it('reports partial coverage rather than full', () => {
    expect(recordingState(on, health(sensor(true), sensor(false)))).toBe('degraded')
  })

  it('treats no declared sensors as no coverage', () => {
    expect(recordingState(on, health())).toBe('no-coverage')
  })

  it('paused wins regardless of sensor health', () => {
    expect(recordingState(off, health(sensor(true)))).toBe('paused')
  })

  it('does not raise a false alarm when health is unknown', () => {
    // A failed health request must not be reported as lost coverage.
    expect(recordingState(on, undefined)).toBe('recording')
  })
})

describe('the recording chip label', () => {
  // The header carries two chips: this one for the recorder, the health pill
  // for coverage. An earlier fix relabelled this chip "No coverage" whenever
  // sensors were unhealthy, so the header showed the identical phrase twice and
  // stopped saying whether recording was even on.
  it('never borrows the health pill wording', () => {
    for (const label of Object.values(RECORDING_LABEL)) {
      expect(label).not.toMatch(/coverage/i)
    }
  })

  it('says what the recorder is doing, not what the sensors are doing', () => {
    expect(RECORDING_LABEL['no-coverage']).toBe('Recording')
    expect(RECORDING_LABEL.degraded).toBe('Recording')
    expect(RECORDING_LABEL.paused).toBe('Paused')
  })

  it('withholds the reassuring tone unless there is real coverage', () => {
    // Tone is what keeps the honest label from reading as "all fine": only a
    // covered, recording system gets the green pulse.
    expect(RECORDING_TONE.recording).toBe('ok')
    expect(RECORDING_TONE['no-coverage']).not.toBe('ok')
    expect(RECORDING_TONE.degraded).not.toBe('ok')
    expect(RECORDING_TONE.paused).toBe('warn')
  })
})
