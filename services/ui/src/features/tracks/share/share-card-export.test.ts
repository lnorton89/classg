/**
 * Regression cover for the secure-context guard.
 *
 * This shipped broken once: the Clipboard API exists only in a secure context,
 * the console is served over plain http on a LAN address, and the guard was
 * removed because the DOM types say `navigator.clipboard` is always defined.
 * The result was `Cannot read properties of undefined (reading 'write')` thrown
 * during render, which took the whole page down on a phone while looking
 * perfect on localhost.
 *
 * The insecure-origin cases are the point: they are the ones a developer on
 * localhost never exercises.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { canCopyImages, canShareFiles, shareCardPng } from './share-card-export'

/** Any non-undefined value satisfies the `typeof … === 'undefined'` probe. */
function clipboardItemStub() {
  return function ClipboardItemStub() {
    /* presence is all that is checked */
  }
}

function stubEnvironment({
  secure,
  clipboard,
  clipboardItem = true,
}: {
  secure: boolean
  clipboard?: Record<string, unknown>
  clipboardItem?: boolean
}) {
  vi.stubGlobal('window', { isSecureContext: secure })
  vi.stubGlobal('navigator', clipboard ? { clipboard } : {})
  vi.stubGlobal('ClipboardItem', clipboardItem ? clipboardItemStub() : undefined)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canCopyImages', () => {
  it('is false on an insecure origin even when the types promise a clipboard', () => {
    // Exactly the shape an insecure origin presents: the property is absent.
    stubEnvironment({ secure: false })
    expect(canCopyImages()).toBe(false)
  })

  it('does not throw when navigator.clipboard is undefined', () => {
    stubEnvironment({ secure: false })
    expect(() => canCopyImages()).not.toThrow()
  })

  it('is false in a secure context that still lacks ClipboardItem', () => {
    stubEnvironment({
      secure: true,
      clipboard: { write: () => Promise.resolve() },
      clipboardItem: false,
    })
    expect(canCopyImages()).toBe(false)
  })

  it('is false in a secure context whose clipboard cannot write images', () => {
    stubEnvironment({ secure: true, clipboard: { writeText: () => Promise.resolve() } })
    expect(canCopyImages()).toBe(false)
  })

  it('is true only when the secure context and both APIs are all present', () => {
    stubEnvironment({ secure: true, clipboard: { write: () => Promise.resolve() } })
    expect(canCopyImages()).toBe(true)
  })
})

describe('canShareFiles', () => {
  it('is false on an insecure origin — the API does not exist there', () => {
    // Exactly the shape a plain-http LAN origin presents, which is how this
    // console is normally reached from a phone.
    vi.stubGlobal('window', { isSecureContext: false })
    vi.stubGlobal('navigator', { share: () => Promise.resolve(), canShare: () => true })
    expect(canShareFiles()).toBe(false)
  })

  it('does not throw when navigator has no share at all', () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', {})
    expect(() => canShareFiles()).not.toThrow()
    expect(canShareFiles()).toBe(false)
  })

  it('requires canShare as well as share', () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { share: () => Promise.resolve() })
    expect(canShareFiles()).toBe(false)
  })

  it('is true when the secure context and both methods are present', () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { share: () => Promise.resolve(), canShare: () => true })
    expect(canShareFiles()).toBe(true)
  })
})

describe('shareCardPng', () => {
  const blob = new Blob(['x'], { type: 'image/png' })
  const details = { title: 't', text: 'x' }

  it('reports unsupported rather than throwing on an insecure origin', async () => {
    vi.stubGlobal('window', { isSecureContext: false })
    vi.stubGlobal('navigator', {})
    expect(await shareCardPng(blob, 'card.png', details)).toBe('unsupported')
  })

  it('reports unsupported when the browser shares text but refuses files', async () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', {
      share: () => Promise.resolve(),
      canShare: () => false,
    })
    expect(await shareCardPng(blob, 'card.png', details)).toBe('unsupported')
  })

  it('treats a dismissed share sheet as cancelled, not a failure', async () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share: () => Promise.reject(new DOMException('cancelled', 'AbortError')),
    })
    expect(await shareCardPng(blob, 'card.png', details)).toBe('cancelled')
  })

  it('propagates a genuine failure so the caller can report it', async () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share: () => Promise.reject(new DOMException('nope', 'NotAllowedError')),
    })
    await expect(shareCardPng(blob, 'card.png', details)).rejects.toThrow()
  })

  it('passes the card through as a PNG file when sharing succeeds', async () => {
    // Collected in an array rather than a reassigned `let`: TypeScript narrows
    // a `let` written only inside a callback to `never` at the read site.
    const received: ShareData[] = []
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share: (data: ShareData) => {
        received.push(data)
        return Promise.resolve()
      },
    })
    expect(await shareCardPng(blob, 'card.png', details)).toBe('shared')
    const file = received.at(0)?.files?.at(0)
    expect(file?.name).toBe('card.png')
    expect(file?.type).toBe('image/png')
  })
})
