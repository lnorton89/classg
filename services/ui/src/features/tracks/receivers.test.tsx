/**
 * The value of the second radio is only visible if the UI attributes it.
 *
 * The failure this guards is quiet: a two-radio unit renders one pooled "peak
 * −46 dBm" that an operator reads as a range cue, when it is really whichever
 * adapter has more gain. Nothing about that looks wrong on screen.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReceiverBreakdown } from './receivers'
import type { Receiver } from '@/lib/api/types'

function show(receivers: Receiver[]) {
  return render(<ReceiverBreakdown receivers={receivers} />)
}

const alfa: Receiver = {
  sensor_id: 'wifi-0',
  sensor_kind: 'wifi',
  detection_count: 30,
  rssi_dbm: -46,
  last_seen: '2026-08-11T14:24:02.100Z',
}
const tplink: Receiver = {
  sensor_id: 'wifi-1',
  sensor_kind: 'wifi',
  detection_count: 12,
  rssi_dbm: -71,
  last_seen: '2026-08-11T14:23:59.000Z',
}

describe('ReceiverBreakdown', () => {
  it('names both radios and keeps their peaks apart', () => {
    show([alfa, tplink])

    expect(screen.getByText('wifi-0')).toBeVisible()
    expect(screen.getByText('wifi-1')).toBeVisible()
    // The two peaks must not be collapsed into the louder one.
    expect(screen.getByText('-46 dBm')).toBeVisible()
    expect(screen.getByText('-71 dBm')).toBeVisible()
  })

  it('orders by contribution, not by sensor id', () => {
    show([{ ...tplink, detection_count: 99 }, alfa])

    const rows = screen.getAllByRole('row').slice(1) // drop the header
    expect(rows[0]).toHaveTextContent('wifi-1')
  })

  it('warns that peaks across different adapters are not comparable', () => {
    show([alfa, tplink])
    expect(screen.getByText(/not the closest pass/i)).toBeVisible()
  })

  it('stays quiet about comparison when only one radio heard the track', () => {
    show([alfa])

    expect(screen.getByText('wifi-0')).toBeVisible()
    // A single receiver has nothing to compare against, and the caveat would
    // be noise on every track on a single-adapter unit.
    expect(screen.queryByText(/not the closest pass/i)).toBeNull()
  })

  it('renders nothing rather than an empty table for an unattributed track', () => {
    // Tracks recorded before fusion carried receivers still load.
    const { container } = show([])
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a dash for a receiver that never reported a signal level', () => {
    show([{ ...alfa, rssi_dbm: null }])
    expect(screen.getByText('wifi-0')).toBeVisible()
  })
})
