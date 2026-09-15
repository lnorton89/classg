/**
 * The contacts panel, which is the accessible form of the map.
 *
 * These pin the manned-traffic behaviour that has no visual equivalent a test
 * can see: that a manned row is a real toggle, that expanding it announces
 * itself, that the detail is the payload and not a re-render of the summary,
 * and that a drone and an aircraft can never be selected at the same time.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClient from '@/lib/api/client'
import type { AircraftLabelsResponse, Detection, Track } from '@/lib/api/types'

import { ContactsPanel } from './contacts-panel'
import { useContactSelection } from './selection'

type ApiClientModule = typeof ApiClient

/**
 * The panel asks for the aircraft labels so a named airframe is listed by its
 * name. Mocked at the client rather than stubbed at the hook: what these are
 * checking is that the label reaches the heading, and a stubbed hook would
 * prove only that the fixture was returned.
 */
const aircraftLabels = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<ApiClientModule>()
  return { ...actual, api: { ...actual.api, aircraftLabels } }
})

const noLabels: AircraftLabelsResponse = { labels: [] }

beforeEach(() => {
  aircraftLabels.mockReset().mockResolvedValue(noLabels)
})

const track: Track = {
  schema_version: '1.0',
  track_id: 'track-1',
  state: 'CONFIRMED',
  first_seen: '2026-08-10T22:00:00Z',
  last_seen: '2026-08-10T22:01:00Z',
  detection_count: 3,
  confidence: 0.6,
  identity: { serial: 'SERIAL-ABC' },
  current: { lat: 46.1, lon: -122.8, track_deg: 90, height_agl_m: 120 },
}

const airliner: Detection = {
  schema_version: '1.0',
  detection_id: 'det-1',
  ts: '2026-08-10T22:00:30Z',
  sensor_id: 'net-1',
  sensor_kind: 'net',
  detection_class: 'D',
  position: { lat: 46.4, lon: -122.4, alt_geodetic_m: 2100 },
  kinematics: { speed_mps: 180, track_deg: 271, vertical_speed_mps: -4.5 },
  rf: { rssi_dbm: -71 },
  adsb: { icao: 'A1B2C3', callsign: ' UAL1234 ', alt_ft: 7000, ground_speed_kt: 350 },
}

/**
 * The 5.8 GHz access point from the 2026-08-17 flight: DJI-built silicon, an
 * OUI match and nothing else. No serial, no position, and not the aircraft.
 */
const vendorMatchOnly: Track = {
  schema_version: '1.0',
  track_id: 'track-ap',
  state: 'TENTATIVE',
  first_seen: '2026-08-10T21:59:00Z',
  last_seen: '2026-08-10T21:59:14Z',
  detection_count: 8,
  confidence: 0.1,
  identity: { macs: ['0c:9a:e6:47:3c:89'], vendor: 'dji' },
  evidence: [{ class: 'C', sensor_kind: 'wifi', weight: 0.1, count: 8 }],
}

/**
 * Four flights of one airframe, the shape the deployed unit actually produces:
 * the same serial over and over, distinguishable only by when each one was.
 */
const firstAircraftFlights: Track[] = [18, 19, 20, 21].map((hour) => ({
  schema_version: '1.0',
  track_id: `closed-${hour}`,
  state: 'CLOSED',
  first_seen: `2026-08-10T${hour}:00:00Z`,
  last_seen: `2026-08-10T${hour}:09:00Z`,
  detection_count: 400,
  confidence: 0.6,
  identity: { serial: 'SERIAL-FIRST', vendor: 'dji' },
  evidence: [{ class: 'A', sensor_kind: 'wifi', weight: 0.6, count: 400 }],
}))

/** A closed track nothing ever identified: a MAC, two detections, no aircraft. */
const closedFingerprint: Track = {
  schema_version: '1.0',
  track_id: 'closed-fingerprint',
  state: 'CLOSED',
  first_seen: '2026-08-10T17:00:00Z',
  last_seen: '2026-08-10T17:00:08Z',
  detection_count: 2,
  confidence: 0.1,
  identity: { macs: ['06:11:22:33:44:55'], vendor: 'dji' },
  evidence: [{ class: 'C', sensor_kind: 'wifi', weight: 0.1, count: 2 }],
}

const helicopter: Detection = {
  ...airliner,
  detection_id: 'det-2',
  adsb: { icao: 'D4E5F6', callsign: null, alt_ft: 1200 },
}

/**
 * The panel as the live route wires it: the real selection hook, so the
 * exclusion these tests assert is the shipped one and not a fixture of the
 * test's own making.
 */
function Panel({
  adsb = [airliner],
  tracks = [track],
  unidentifiedTracks = [],
  closedTracks = [],
  showClosed = false,
  splitId,
}: {
  adsb?: Detection[]
  tracks?: Track[]
  unidentifiedTracks?: Track[]
  closedTracks?: Track[]
  showClosed?: boolean
  splitId?: string
}) {
  const { selectedTrackId, selectedMannedIcao, selectTrack, selectManned } =
    useContactSelection()
  return (
    <ContactsPanel
      splitId={splitId}
      tracks={tracks}
      unidentifiedTracks={unidentifiedTracks}
      closedTracks={closedTracks}
      adsb={adsb}
      showClosed={showClosed}
      selectedTrackId={selectedTrackId}
      onSelectTrack={selectTrack}
      selectedMannedIcao={selectedMannedIcao}
      onSelectManned={selectManned}
    />
  )
}

/**
 * TrackRow renders a <Link>, which needs a router in scope. The router resolves
 * its first match asynchronously, so this waits for the panel to actually be on
 * screen rather than handing back an empty tree.
 */
async function renderInRouter(component: ReactNode) {
  const rootRoute = createRootRoute()
  const testRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([testRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  await screen.findByText(/Manned traffic/)
  return result
}

function mannedButton(name: RegExp) {
  return screen.getByRole('button', { name })
}

describe('manned contacts', () => {
  it('toggles selection on and off', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel />)

    const row = mannedButton(/UAL1234/)
    expect(row).toHaveAttribute('aria-pressed', 'false')
    expect(row).toHaveAttribute('aria-expanded', 'false')

    await user.click(row)
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-pressed', 'true')
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-expanded', 'true')

    await user.click(mannedButton(/UAL1234/))
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-pressed', 'false')
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-expanded', 'false')
  })

  it('is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel tracks={[]} />)

    await user.tab()
    expect(mannedButton(/UAL1234/)).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-expanded', 'true')
  })

  it('names the expanded region so a screen reader can follow the button to it', async () => {
    const user = userEvent.setup()
    const { container } = await renderInRouter(<Panel />)

    await user.click(mannedButton(/UAL1234/))

    const controls = mannedButton(/UAL1234/).getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(container.querySelector(`#${controls ?? ''}`)).not.toBeNull()
  })

  it('reveals the detail the payload already carried', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel />)

    // Nothing but the summary before the row is opened.
    expect(screen.queryByText('Ground speed')).toBeNull()

    await user.click(mannedButton(/UAL1234/))

    // Default preferences: metric units, decimal coordinates, timestamps as
    // absolute-plus-relative.
    const detail = screen.getByText('Position').closest('dl')
    expect(detail).not.toBeNull()
    const fields = within(detail as HTMLElement)

    expect(fields.getByText('46.400000, -122.400000')).toBeInTheDocument()
    // 7000 ft, shown in the operator's chosen units.
    expect(fields.getByText(/2134\s*m/)).toBeInTheDocument()
    expect(fields.getByText(/2100.0\s*m/)).toBeInTheDocument()
    expect(fields.getByText(/180.0\s*m\/s/)).toBeInTheDocument()
    expect(fields.getByText('271°')).toBeInTheDocument()
    expect(fields.getByText(/-4.5\s*m\/s/)).toBeInTheDocument()
    expect(fields.getByText(/-71\s*dBm/)).toBeInTheDocument()
    expect(fields.getByText(/ago|just now/)).toBeInTheDocument()
  })

  it('falls back to the ADS-B ground speed when kinematics carries none', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel adsb={[{ ...airliner, kinematics: null }]} />)

    await user.click(mannedButton(/UAL1234/))
    // 350 kt is 180.1 m/s. Converted here rather than dropped, so the operator's
    // unit preference still governs the reading.
    expect(screen.getByText(/180.1\s*m\/s/)).toBeInTheDocument()
  })

  it('never claims ADS-B feeds a drone confidence', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel />)
    await user.click(mannedButton(/UAL1234/))

    expect(screen.getByText(/Never contributes to a drone's confidence/)).toBeInTheDocument()
  })

  it('keeps the word "manned" alongside the selected highlight', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel />)

    await user.click(mannedButton(/UAL1234/))
    // Selection must not be the only thing distinguishing manned traffic, so
    // the explicit word survives being selected.
    expect(mannedButton(/UAL1234/)).toHaveAccessibleName(/manned/i)
  })

  it('shows only one detail at a time', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel adsb={[airliner, helicopter]} />)

    await user.click(mannedButton(/UAL1234/))
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-pressed', 'true')

    // The second row falls back to the ICAO address, having no callsign.
    await user.click(mannedButton(/D4E5F6/))
    expect(mannedButton(/D4E5F6/)).toHaveAttribute('aria-pressed', 'true')
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('drone and manned selection are mutually exclusive', () => {
  it('clears the drone track when an aircraft is picked', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel />)

    const droneRow = screen.getByRole('button', { name: /SERIAL-ABC/ })
    await user.click(droneRow)
    expect(screen.getByRole('button', { name: /SERIAL-ABC/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(mannedButton(/UAL1234/))
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /SERIAL-ABC/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('clears the aircraft when a drone track is picked', async () => {
    const user = userEvent.setup()
    await renderInRouter(<Panel />)

    await user.click(mannedButton(/UAL1234/))
    await user.click(screen.getByRole('button', { name: /SERIAL-ABC/ }))

    expect(screen.getByRole('button', { name: /SERIAL-ABC/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(mannedButton(/UAL1234/)).toHaveAttribute('aria-pressed', 'false')
  })
})

/**
 * A vendor match is a statement about who built a radio, not about what is
 * flying. Listing one among drone tracks is how a single flight read as two
 * aircraft on 2026-08-17.
 */
describe('unidentified RF', () => {
  /** The shelf is closed until asked for; everything below it needs it open. */
  async function openShelf() {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Unidentified RF/ }))
  }

  it('is kept out of the drone track count', async () => {
    await renderInRouter(<Panel unidentifiedTracks={[vendorMatchOnly]} />)

    expect(screen.getByText('Active drone tracks (1)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Unidentified RF \(1\)/ })).toBeInTheDocument()
  })

  it('is shelved rather than listed, and says how many it is holding', async () => {
    // Open by default it was a standing list of access points beside the
    // aircraft, which is the confusion the section exists to end.
    await renderInRouter(<Panel unidentifiedTracks={[vendorMatchOnly]} />)

    const shelf = screen.getByRole('button', { name: /Unidentified RF/ })
    expect(shelf).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('0c:9a:e6:47:3c:89')).not.toBeInTheDocument()
  })

  it('names the vendor and says it is never plotted, once opened', async () => {
    await renderInRouter(<Panel unidentifiedTracks={[vendorMatchOnly]} />)
    await openShelf()

    const section = screen.getByRole('region', { name: /Unidentified RF/ })
    expect(within(section).getByText('0c:9a:e6:47:3c:89')).toBeInTheDocument()
    expect(within(section).getByText(/dji hardware/)).toBeInTheDocument()
    expect(within(section).getByText(/never plotted/i)).toBeInTheDocument()
  })

  it('does not describe a contact still being heard as closed', async () => {
    await renderInRouter(<Panel unidentifiedTracks={[vendorMatchOnly]} />)
    await openShelf()

    const section = screen.getByRole('region', { name: /Unidentified RF/ })
    expect(within(section).queryByText(/closed/i)).not.toBeInTheDocument()
  })

  it('shows no section at all when there is nothing unidentified', async () => {
    await renderInRouter(<Panel />)

    expect(screen.queryByText(/Unidentified RF/)).not.toBeInTheDocument()
  })

  /*
   * The shelf takes closed fingerprints too. On the deployed unit those are
   * MAC-only contacts with one or two detections, and they sat in the closed
   * list between real flights, each one looking like an aircraft that had been
   * up.
   */
  it('takes a closed track nothing ever identified, away from the flights', async () => {
    await renderInRouter(
      <Panel showClosed closedTracks={[closedFingerprint, ...firstAircraftFlights]} />,
    )

    expect(screen.getByRole('button', { name: /Unidentified RF \(1\)/ })).toBeInTheDocument()
    const flights = screen.getByRole('region', { name: /Closed flights/ })
    expect(within(flights).queryByText('06:11:22:33:44:55')).not.toBeInTheDocument()
  })

  it('leaves a closed fingerprint out of the shelf when closed tracks are hidden', async () => {
    // Hiding the closed section has to hide all of it. A shelf that kept
    // counting them would be a claim about the sky the operator opted out of.
    await renderInRouter(<Panel closedTracks={[closedFingerprint]} />)

    expect(screen.queryByText(/Unidentified RF/)).not.toBeInTheDocument()
  })
})

/**
 * The closed list repeated one serial 29 times on the deployed unit, every row
 * saying "closed 4 hours ago" and nothing that told them apart. Identity is
 * stated once now and each row under it is a flight.
 */
describe('closed flights', () => {
  it('states the airframe once and lists its flights under it', async () => {
    await renderInRouter(<Panel showClosed closedTracks={firstAircraftFlights} />)

    const flights = screen.getByRole('region', { name: /Closed flights/ })
    expect(within(flights).getAllByText('SERIAL-FIRST')).toHaveLength(1)
    expect(within(flights).getByText('4 flights')).toBeInTheDocument()
  })

  it('shows the last few and offers the rest on the Flights page', async () => {
    await renderInRouter(<Panel showClosed closedTracks={firstAircraftFlights} />)

    const flights = screen.getByRole('region', { name: /Closed flights/ })
    // Three of four, so one is behind the link.
    const more = within(flights).getByRole('link', { name: /1 more flight/ })
    expect(more).toHaveAttribute('href', expect.stringContaining('q=SERIAL-FIRST'))
  })

  it('shows no "more" link when every flight is listed', async () => {
    await renderInRouter(<Panel showClosed closedTracks={firstAircraftFlights.slice(0, 2)} />)

    expect(screen.queryByRole('link', { name: /more flight/ })).not.toBeInTheDocument()
  })

  it('lists the newest flight first', async () => {
    await renderInRouter(<Panel showClosed closedTracks={firstAircraftFlights} />)

    const flights = screen.getByRole('region', { name: /Closed flights/ })
    const rows = within(flights).getAllByRole('link', { name: /2026/ })
    // Default preferences render an absolute timestamp; the newest of the four
    // starts at 21:00 and the oldest listed at 19:00.
    expect(rows[0]).toHaveTextContent('21:0')
    expect(rows[2]).toHaveTextContent('19:0')
  })

  it('calls the aircraft by the name the operator gave it', async () => {
    aircraftLabels.mockResolvedValue({
      labels: [
        {
          serial: 'SERIAL-FIRST',
          label: "Neighbour's Mini 4 Pro",
          flag: 'known',
          updated_at: '2026-09-01T00:00:00Z',
        },
      ],
    })
    await renderInRouter(<Panel showClosed closedTracks={firstAircraftFlights} />)

    expect(await screen.findByText("Neighbour's Mini 4 Pro")).toBeInTheDocument()
    expect(screen.queryByText('SERIAL-FIRST')).not.toBeInTheDocument()
  })

  it('says so rather than claiming an empty sky when there are none', async () => {
    await renderInRouter(<Panel showClosed />)

    expect(screen.getByText('Closed flights (0)')).toBeInTheDocument()
  })
})

/**
 * The vertical divider between the active tracks and the reference sections
 * below them, which only the wide layout asks for.
 *
 * jsdom cannot measure a drag, so these do not try to. What they pin is the
 * part that has actually gone wrong before in this file's other split: that
 * restructuring the panel into panes does not lose a section, and that the
 * narrow layout -- where the column is one of two tabs -- gets no divider to
 * squeeze a list with.
 */
describe('resizable sections', () => {
  it('keeps every section reachable once the panel is split', async () => {
    await renderInRouter(
      <Panel splitId="test-contacts" unidentifiedTracks={[vendorMatchOnly]} />,
    )

    expect(screen.getByRole('region', { name: /Active drone tracks/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /Unidentified RF/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /Manned traffic/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /SERIAL-ABC/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /UAL1234/ })).toBeInTheDocument()
  })

  it('offers a handle when split and none when not', async () => {
    const { unmount } = await renderInRouter(<Panel splitId="test-contacts" />)
    expect(screen.getByRole('separator')).toBeInTheDocument()
    unmount()

    await renderInRouter(<Panel />)
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })
})

/**
 * The audit found the closed-tracks list ending in a row sliced through the
 * middle, with the "Manned traffic" heading starting immediately under the cut
 * — a scroll container behaving correctly and reading as a broken panel.
 *
 * jsdom has no layout, so there is nothing here that can see a fade. What it
 * can pin is that every scroll region still carries the affordance that makes
 * the cut deliberate, and that the headings a clipped row runs under are opaque
 * rather than showing it through.
 */
describe('section boundaries', () => {
  it('gives every scrollable section a faded edge and clearance under it', async () => {
    const user = userEvent.setup()
    await renderInRouter(
      <Panel splitId="test-contacts" unidentifiedTracks={[vendorMatchOnly]} />,
    )
    // The shelf has no list to clip while it is closed.
    await user.click(screen.getByRole('button', { name: /Unidentified RF/ }))

    for (const name of [/Active drone tracks/, /Unidentified RF/, /Manned traffic/]) {
      const region = screen.getByRole('region', { name })
      const scroller = region.className.includes('overflow-y-auto')
        ? region
        : region.querySelector('.overflow-y-auto')
      expect(scroller, `${String(name)} has a scroll container`).not.toBeNull()
      expect(scroller?.className).toContain('scroll-fade-b')
      // Taller than the 1.25rem fade, so the last row clears it at the end of
      // the scroll instead of being read through the gradient.
      expect(scroller?.className).toContain('pb-6')
    }
  })

  it('makes a section heading an opaque lid on the list above it', async () => {
    await renderInRouter(<Panel splitId="test-contacts" />)

    const heading = screen.getByRole('heading', { name: /Manned traffic/ })
    expect(heading.className).toContain('bg-card')
    // Not bg-card/95: a translucent lid shows the clipped row through itself.
    expect(heading.className).not.toContain('bg-card/')
  })
})
