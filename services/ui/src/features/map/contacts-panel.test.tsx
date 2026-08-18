/**
 * The contacts panel, which is the accessible form of the map.
 *
 * These pin the manned-traffic behaviour that has no visual equivalent a test
 * can see: that a manned row is a real toggle, that expanding it announces
 * itself, that the detail is the payload and not a re-render of the summary,
 * and that a drone and an aircraft can never be selected at the same time.
 */
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
import { describe, expect, it } from 'vitest'

import type { Detection, Track } from '@/lib/api/types'

import { ContactsPanel } from './contacts-panel'
import { useContactSelection } from './selection'

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
}: {
  adsb?: Detection[]
  tracks?: Track[]
  unidentifiedTracks?: Track[]
}) {
  const { selectedTrackId, selectedMannedIcao, selectTrack, selectManned } =
    useContactSelection()
  return (
    <ContactsPanel
      tracks={tracks}
      unidentifiedTracks={unidentifiedTracks}
      adsb={adsb}
      showClosed={false}
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

  const result = render(<RouterProvider router={router} />)
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
  it('is kept out of the drone track count', async () => {
    await renderInRouter(<Panel unidentifiedTracks={[vendorMatchOnly]} />)

    expect(screen.getByText('Active drone tracks (1)')).toBeInTheDocument()
    expect(screen.getByText('Unidentified RF (1)')).toBeInTheDocument()
  })

  it('names the vendor and says it is never plotted', async () => {
    await renderInRouter(<Panel unidentifiedTracks={[vendorMatchOnly]} />)

    const section = screen.getByRole('region', { name: /Unidentified RF/ })
    expect(within(section).getByText('0c:9a:e6:47:3c:89')).toBeInTheDocument()
    expect(within(section).getByText(/dji hardware/)).toBeInTheDocument()
    expect(within(section).getByText(/never plotted/i)).toBeInTheDocument()
  })

  it('does not describe a contact still being heard as closed', async () => {
    await renderInRouter(<Panel unidentifiedTracks={[vendorMatchOnly]} />)

    const section = screen.getByRole('region', { name: /Unidentified RF/ })
    expect(within(section).queryByText(/closed/i)).not.toBeInTheDocument()
  })

  it('shows no section at all when there is nothing unidentified', async () => {
    await renderInRouter(<Panel />)

    expect(screen.queryByText(/Unidentified RF/)).not.toBeInTheDocument()
  })
})
