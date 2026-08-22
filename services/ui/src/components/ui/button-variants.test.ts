import { describe, expect, it } from 'vitest'

// ?raw, so these are the route files' text and not their modules: the point is
// to read what the two 404 pages ask for, without mounting a router to do it.
import rootRoute from '../../routes/__root.tsx?raw'
import trackRoute from '../../routes/tracks/$trackId.tsx?raw'

import { buttonVariants } from './button-variants'

/**
 * The audit found the two 404 pages — the route one in `routes/__root.tsx` and
 * the track one in `routes/tracks/$trackId.tsx` — rendering their action link
 * differently, one a solid light chip and one an outline. Both are written
 * with exactly `buttonVariants({ variant: 'outline', size: 'sm' })`, so the
 * difference never came from the call sites. It came from the variant painting
 * `bg-background`, the PAGE ground, onto an Alert whose ground is
 * `bg-muted/40`: nearly invisible in the dark theme, a near-white rectangle in
 * the light one.
 */
describe('buttonVariants', () => {
  it('does not paint the page ground on the outline variant', () => {
    const classes = buttonVariants({ variant: 'outline', size: 'sm' }).split(/\s+/)

    // The regression: an outline button has to inherit the surface it sits on,
    // or it reads as a filled chip anywhere that is not the page ground —
    // inside an Alert, on the header, on a card.
    expect(classes).toContain('bg-transparent')
    expect(classes).not.toContain('bg-background')
    expect(classes).toContain('border')
  })

  it('is asked for identically by both 404 pages', () => {
    // Source-level on purpose. Rendering the two routes would prove they agree
    // today; what actually broke here is one of them being restyled on its own
    // later, and that is a difference in the call, not in the output.
    const call = "buttonVariants({ variant: 'outline', size: 'sm' })"
    expect(rootRoute, 'routes/__root.tsx 404 action').toContain(call)
    expect(trackRoute, 'routes/tracks/$trackId.tsx 404 action').toContain(call)
  })
})
