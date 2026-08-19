import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useMenuKeys } from './use-menu-keys'

function Menu({ disabledLast = false }: { disabledLast?: boolean }) {
  const [menuRef, onMenuKeyDown] = useMenuKeys()
  return (
    <div ref={menuRef} onKeyDown={onMenuKeyDown} role="menu" aria-label="Test" tabIndex={-1}>
      {/* Not a menuitem: the header a real menu carries above its items. */}
      <p>Signed in as someone</p>
      <button type="button" role="menuitem">
        First
      </button>
      <button type="button" role="menuitem">
        Second
      </button>
      <button type="button" role="menuitem" disabled={disabledLast}>
        Third
      </button>
    </div>
  )
}

function press(key: string) {
  fireEvent.keyDown(screen.getByRole('menu'), { key })
}

describe('useMenuKeys', () => {
  it('opens onto the first item and wraps at the end', () => {
    render(<Menu />)

    press('ArrowDown')
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus()

    press('ArrowDown')
    press('ArrowDown')
    expect(screen.getByRole('menuitem', { name: 'Third' })).toHaveFocus()

    press('ArrowDown')
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus()
  })

  it('goes backwards from nothing focused to the last item', () => {
    render(<Menu />)

    press('ArrowUp')
    expect(screen.getByRole('menuitem', { name: 'Third' })).toHaveFocus()
  })

  it('jumps with Home and End, because Sign out is the last item', () => {
    render(<Menu />)

    press('End')
    expect(screen.getByRole('menuitem', { name: 'Third' })).toHaveFocus()

    press('Home')
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus()
  })

  it('skips a disabled item rather than focusing a dead end', () => {
    render(<Menu disabledLast />)

    press('End')
    expect(screen.getByRole('menuitem', { name: 'Second' })).toHaveFocus()
  })

  it('leaves other keys alone so the panel can still scroll', () => {
    render(<Menu />)
    const menu = screen.getByRole('menu')

    // Not preventDefault-ed: PageDown must still reach the scroll container.
    const handled = fireEvent.keyDown(menu, { key: 'PageDown' })
    expect(handled).toBe(true)
    expect(document.body).toHaveFocus()
  })
})
