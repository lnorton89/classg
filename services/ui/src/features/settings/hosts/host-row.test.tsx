import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HostRow } from './host-row'
import type { SystemHost } from '@/lib/api/types'

function host(overrides: Partial<SystemHost> = {}): SystemHost {
  return {
    uptime_s: 12167,
    load1: 0.69,
    load5: 1.32,
    load15: 1.06,
    cpu_count: 4,
    cpu_temp_c: 46.251,
    mem_total_kb: 3887868,
    mem_available_kb: 3409708,
    disk_path: '/data',
    disk_total_bytes: 125585461248,
    disk_free_bytes: 92687323136,
    ...overrides,
  }
}

describe('HostRow', () => {
  it('renders the reading when the receiver reported one', () => {
    render(
      <dl>
        <HostRow
          label="CPU temperature"
          host={host()}
          field="cpu_temp_c"
          reason="cpu_temp_c"
          render={(v) => `${v.toFixed(1)} °C`}
        />
      </dl>,
    )

    expect(screen.getByText('46.3 °C')).toBeInTheDocument()
  })

  // The rule this component exists for. A dash would sit in the same visual
  // language as a real number, and for a temperature or an uptime that is
  // indistinguishable from a reading of zero.
  it('says Unavailable and gives the reason instead of rendering a dash', () => {
    render(
      <dl>
        <HostRow
          label="CPU temperature"
          host={host({
            cpu_temp_c: null,
            unavailable: { cpu_temp_c: 'no readable /sys/class/thermal' },
          })}
          field="cpu_temp_c"
          reason="cpu_temp_c"
          render={(v) => `${v.toFixed(1)} °C`}
        />
      </dl>,
    )

    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText('no readable /sys/class/thermal')).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
    expect(screen.queryByText(/0\.0 °C/)).not.toBeInTheDocument()
  })

  it('falls back to a generic reason when the receiver named none', () => {
    render(
      <dl>
        <HostRow
          label="Uptime"
          host={host({ uptime_s: null })}
          field="uptime_s"
          reason="uptime_s"
          render={(v) => String(v)}
        />
      </dl>,
    )

    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText('Not reported by the receiver')).toBeInTheDocument()
  })

  // A zero is a real reading and must not be mistaken for a missing one: an
  // idle Pi genuinely reports load 0.00.
  it('renders a genuine zero as a value, not as unavailable', () => {
    render(
      <dl>
        <HostRow
          label="Load"
          host={host({ load1: 0 })}
          field="load1"
          reason="load"
          render={(v) => v.toFixed(2)}
        />
      </dl>,
    )

    expect(screen.getByText('0.00')).toBeInTheDocument()
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
  })

  it('shows a reading-in-progress state before the first response', () => {
    render(
      <dl>
        <HostRow
          label="Uptime"
          host={undefined}
          field="uptime_s"
          reason="uptime_s"
          render={(v) => String(v)}
        />
      </dl>,
    )

    expect(screen.getByText('Reading…')).toBeInTheDocument()
  })
})
