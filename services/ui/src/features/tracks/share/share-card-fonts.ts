/**
 * Embeds Manrope into the exported card.
 *
 * On screen the card just uses the app's bundled webfont. The exported PNG
 * cannot: rasterising serialises the SVG into an `<img>`, and an image loaded
 * that way has no document, so no `@font-face` from the page applies. Left
 * alone the export silently falls back to whatever the OS has, and the card
 * that is supposed to carry the brand comes out in Arial.
 *
 * A font referenced by `data:` URI from inside the SVG's own `<style>` is not
 * an external fetch, so it survives the same isolation that strips everything
 * else. The bytes are fetched at export time rather than inlined into the
 * bundle: @fontsource has already served these files to render the page, so
 * this is a cache hit, and the console is served off a Pi over its own AP where
 * ~40 kB of base64 in the main chunk would be paid on every load by everyone,
 * including the people who never share a card.
 *
 * Weights are deliberately few. Each is ~14 kB, and the wordmark is specified as
 * Manrope ExtraBold in docs/planning/brand-identity.md, so 800 is the one that
 * is not negotiable.
 */
import manrope500 from '@fontsource/manrope/files/manrope-latin-500-normal.woff2?url'
import manrope700 from '@fontsource/manrope/files/manrope-latin-700-normal.woff2?url'
import manrope800 from '@fontsource/manrope/files/manrope-latin-800-normal.woff2?url'

const WEIGHTS: { weight: number; url: string }[] = [
  { weight: 500, url: manrope500 },
  { weight: 700, url: manrope700 },
  { weight: 800, url: manrope800 },
]

/** Cached across exports; the bytes never change within a session. */
let cached: string | null = null

async function toBase64(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`font fetch failed: ${response.status}`)
  const buffer = new Uint8Array(await response.arrayBuffer())
  // Chunked because `String.fromCharCode(...bytes)` blows the argument limit on
  // a 14 kB font and throws RangeError.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * `@font-face` rules with the font bytes inlined, or an empty string if the
 * fonts could not be read.
 *
 * Failure is deliberately not fatal: a card in a fallback face is worth more
 * than an error where the card should be, and the layout is built so the
 * substitution degrades rather than collides.
 */
export async function embeddedFontCss(): Promise<string> {
  if (cached !== null) return cached
  try {
    const faces = await Promise.all(
      WEIGHTS.map(async ({ weight, url }) => {
        const base64 = await toBase64(url)
        return (
          `@font-face{font-family:'Manrope';font-style:normal;` +
          `font-weight:${weight};src:url(data:font/woff2;base64,${base64}) format('woff2');}`
        )
      }),
    )
    cached = faces.join('')
  } catch {
    cached = ''
  }
  return cached
}
