import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

/**
 * jsdom has no ResizeObserver, and react-resizable-panels constructs one
 * unguarded the moment a Group mounts. Without this stub every test that
 * renders a resizable split dies on `not a constructor` before asserting
 * anything -- which is why the live route's splits had no coverage at all.
 *
 * It observes nothing, and it does not need to: a test cannot measure a layout
 * in jsdom. What it can check is that the panes, their headings, and the handle
 * are present and reachable, and that is what the stub makes possible.
 *
 * Assigned unconditionally rather than only when missing. TypeScript's DOM lib
 * declares ResizeObserver as always present, so a `??=` guard is a condition it
 * can prove is never taken -- and a real one would be the wrong thing anyway,
 * since a jsdom that grew a working implementation should be used, not this.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {
    return
  }
  unobserve(): void {
    return
  }
  disconnect(): void {
    return
  }
}

globalThis.ResizeObserver = NoopResizeObserver

afterEach(() => cleanup())
