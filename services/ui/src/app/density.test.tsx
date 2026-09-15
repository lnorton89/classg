/**
 * The compact density preference, as far as a DOM without a CSS engine can
 * take it.
 *
 * The setting existed, was persisted, and changed nothing an operator could
 * see on half the surfaces it claimed to cover, because the contract has two
 * halves in two files: the provider writes `data-density` on the root element,
 * and every dense surface emits a `data-density-*` hook for `styles.css` to
 * act on. Neither half typechecks against the other, and a component that
 * forgets its hook fails silently — it simply does not get denser.
 *
 * happy-dom applies no stylesheet and the app tsconfig carries no node types,
 * so the third half — that `styles.css` still carries a rule naming each hook
 * — is not assertable here and is checked by reading the file. What this pins
 * is the part that regresses: the attribute is written, and every surface the
 * Appearance page promises emits its hook.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { PreferencesProvider } from '@/app/preferences'
import { usePreferences } from '@/app/preferences-context'
import { KeyValueGroup } from '@/components/ui/key-value-group'
import { MetricStrip } from '@/components/ui/metric-strip'
import { DataList, DataRow } from '@/components/ui/misc'

function DensityToggle() {
  const { preferences, setPreference } = usePreferences()
  return (
    <button type="button" onClick={() => setPreference('density', 'compact')}>
      density is {preferences.density}
    </button>
  )
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.density
})

describe('the density preference reaches the document', () => {
  it('starts comfortable and becomes compact on the root element', async () => {
    const user = userEvent.setup()
    render(
      <PreferencesProvider>
        <DensityToggle />
      </PreferencesProvider>,
    )

    expect(document.documentElement.dataset.density).toBe('comfortable')
    await user.click(screen.getByRole('button'))
    expect(document.documentElement.dataset.density).toBe('compact')
  })

  it('survives a reload, because a field operator sets this once', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <PreferencesProvider>
        <DensityToggle />
      </PreferencesProvider>,
    )
    await user.click(screen.getByRole('button'))
    unmount()

    render(
      <PreferencesProvider>
        <DensityToggle />
      </PreferencesProvider>,
    )
    expect(document.documentElement.dataset.density).toBe('compact')
  })
})

/**
 * Tables are absent here on purpose: `styles.css` acts on `:is(td, th)`
 * directly, so every table in the app is covered without opting in. Only the
 * three surfaces that have to emit an attribute can forget to.
 */
describe('every surface the setting claims to cover emits a hook', () => {
  it('DataList and DataRow', () => {
    const { container } = render(
      <DataList label="Radio">
        <DataRow label="Interface" value="wlan1" />
      </DataList>,
    )
    expect(container.querySelector('[data-density-group]')).not.toBeNull()
    expect(container.querySelector('[data-density-row]')).not.toBeNull()
  })

  it('KeyValueGroup', () => {
    const { container } = render(
      <KeyValueGroup
        title="Radio"
        entries={[{ id: 'a', label: 'Interface', value: 'wlan1' }]}
      />,
    )
    expect(container.querySelector('[data-density-group]')).not.toBeNull()
    expect(container.querySelector('[data-density-row]')).not.toBeNull()
  })

  it('MetricStrip', () => {
    const { container } = render(
      <MetricStrip metrics={[{ id: 'a', label: 'Heard', value: '1' }]} />,
    )
    expect(container.querySelector('[data-density-strip]')).not.toBeNull()
  })
})
