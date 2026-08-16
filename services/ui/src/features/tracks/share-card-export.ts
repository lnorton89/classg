/**
 * Rasterise the share card to a PNG, entirely in the browser.
 *
 * No server round trip and no rendering dependency: the Pi serves a static
 * bundle and has no headless browser to draw with, so anything that had to be
 * rendered server-side would work in dev and not on the device.
 *
 * The SVG is inlined as a `charset=utf-8` data URL rather than base64 because
 * `btoa` throws on any non-Latin1 character, and a serial or vendor string is
 * not guaranteed to be ASCII. It is a data URL rather than a blob URL because a
 * blob URL counts as a separate origin in Safari, which taints the canvas and
 * makes `toBlob` throw a SecurityError on export.
 */

import { embeddedFontCss } from './share-card-fonts'

/** 2x. Enough that the card stays sharp pasted into a doc or opened on a phone. */
export const EXPORT_SCALE = 2

/**
 * Whether this browser can be handed an image on the clipboard.
 *
 * The same trap as `navigator.clipboard` in copy-button.tsx, and it bites
 * harder where this is called during render: the Clipboard API exists only in a
 * SECURE CONTEXT, and the console's normal deployment is plain http on a LAN
 * address. `navigator.clipboard` is then genuinely `undefined`.
 *
 * The DOM types declare it as always present, so the compiler cannot catch it
 * and lint actively argues the guard is redundant. It is not: without the guard
 * this threw `Cannot read properties of undefined (reading 'write')` during
 * render and took the whole page down on a phone. Localhost is a secure
 * context, which is exactly why it looks fine while you are developing.
 */
export function canCopyImages(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext) return false
  if (typeof ClipboardItem === 'undefined') return false
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return typeof navigator.clipboard?.write === 'function'
}

export class ShareCardExportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ShareCardExportError'
  }
}

function serialise(svg: SVGSVGElement, fontCss: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  // A serialised fragment carries no namespace of its own; without these the
  // string parses as unknown elements and the image never loads.
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')

  if (fontCss) {
    // Prepended, so the faces are defined before anything referencing them.
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.textContent = fontCss
    clone.insertBefore(style, clone.firstChild)
  }
  return new XMLSerializer().serializeToString(clone)
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () =>
      reject(new ShareCardExportError('The card image could not be rendered.'))
    image.src = source
  })
}

export async function renderCardToPngBlob(
  svg: SVGSVGElement,
  { width, height, scale = EXPORT_SCALE }: { width: number; height: number; scale?: number },
): Promise<Blob> {
  // The card is branded type; without the embedded faces the PNG silently
  // falls back to a system sans. Failure here is non-fatal by design.
  const fontCss = await embeddedFontCss()
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialise(svg, fontCss))}`
  const image = await loadImage(source)

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)

  const context = canvas.getContext('2d')
  if (!context) throw new ShareCardExportError('This browser has no 2D canvas context.')

  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new ShareCardExportError('The card could not be encoded as a PNG.'))
    }, 'image/png')
  })
}

/**
 * A filename someone can find again later. The identifier is sanitised because
 * a MAC's colons are illegal in a Windows filename and are silently dropped or
 * rejected depending on the browser.
 */
export function cardFilename(title: string, lastSeen: string | null): string {
  const safe = title.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'track'
  const stamp = lastSeen ? (lastSeen.slice(0, 19).replace(/[:T]/g, '-') || 'unknown') : 'unknown'
  return `classg-${safe}-${stamp}.png`
}

/** What happened when we offered the card to the OS share sheet. */
export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported'

/**
 * Whether this browser can hand a FILE to the OS share sheet.
 *
 * Three separate things have to be true and they fail independently, which is
 * why this is not a one-line check:
 *
 *   1. Secure context. Like the clipboard, the Web Share API simply does not
 *      exist on a plain-http origin — and plain http on a LAN address is how
 *      this console is normally reached. Guarded first and explicitly, because
 *      the DOM types swear `navigator.share` is always defined and lint will
 *      argue for deleting the check.
 *   2. `share` AND `canShare` both present. Some browsers ship one without the
 *      other.
 *   3. Files specifically. Desktop Chrome and several others expose the whole
 *      API and still refuse `files`, so text shares fine and an image does not.
 *      Only `canShare({files})` with a REAL File answers that, which is why the
 *      final check lives in `shareCardPng` where a file exists.
 */
export function canShareFiles(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext) return false
  if (typeof navigator === 'undefined') return false
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
}

/**
 * Offer the card to the OS share sheet.
 *
 * Dismissing the sheet rejects with `AbortError`. That is a person changing
 * their mind, not a failure, and reporting it as one would put an error toast
 * on screen every time someone backs out of sharing.
 */
export async function shareCardPng(
  blob: Blob,
  filename: string,
  details: { title: string; text: string },
): Promise<ShareOutcome> {
  if (!canShareFiles()) return 'unsupported'

  const file = new File([blob], filename, { type: 'image/png' })
  if (!navigator.canShare({ files: [file] })) return 'unsupported'

  try {
    await navigator.share({ files: [file], title: details.title, text: details.text })
    return 'shared'
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
    throw error
  }
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
