/**
 * Rasterise the PWA icon set from the canonical brand mark.
 *
 * `public/brand/classg-icon.svg` is the single source of truth (see
 * public/brand/README.md — the mark must not be redrawn). Everything here is a
 * transform of that one file, so a brand change is one edit plus one command:
 *
 *   npm run gen:icons
 *
 * Three shapes come out of it, because the platforms want different things:
 *
 *   any        the mark as drawn, rounded frame and all. Chrome shows this
 *              as-is in the install prompt and the task switcher.
 *   maskable   Android clips every launcher icon to whatever mask the OEM
 *              chose (circle, squircle, teardrop). Only a centred circle of
 *              80% diameter is guaranteed to survive, so the frame is dropped
 *              for a full-bleed Night field and the glyph is pulled inside it.
 *              Shipping the `any` art as maskable is what produces the icons
 *              with their corners bitten off.
 *   apple      iOS ignores the manifest entirely, applies its own squircle,
 *              and composites transparency onto black. Full-bleed, opaque.
 *
 * The glyph is drawn centred on (84,84) rather than (80,80) of its 160-unit
 * box — the open end of the sensor trace sits right — so both derived shapes
 * re-centre it before scaling. Measured off the paths, not guessed: the widest
 * feature is the outer arc at r=54 plus its 5-unit stroke.
 *
 * Output is committed. This does not run in CI or in the Docker build; sharp is
 * a devDependency for this script alone.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '../public')
const source = resolve(publicDir, 'brand/classg-icon.svg')

/** Brand Night. The manifest, the theme-color meta and this must agree. */
const NIGHT = '#031124'

/**
 * The rounded frame, removed for the full-bleed variants. Matched literally so
 * that a redrawn mark fails loudly here instead of silently producing icons
 * with a stray border floating inside the OS mask.
 */
const FRAME =
  '<rect x="1" y="1" width="158" height="158" rx="6" fill="#031124" stroke="#16415D" stroke-width="1.5"/>'

const svg = readFileSync(source, 'utf8')
if (!svg.includes(FRAME)) {
  console.error(
    `${source} no longer contains the frame rect this script strips.\n` +
      'The brand mark changed: re-read generate-icons.mjs against it before regenerating.',
  )
  process.exit(1)
}

/** Everything inside <svg>, minus the a11y metadata and the frame. */
const glyph = svg
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>[\s\S]*$/, '')
  .replace(/<title[\s\S]*?<\/title>/, '')
  .replace(/<desc[\s\S]*?<\/desc>/, '')
  .replace(FRAME, '')
  .trim()

/**
 * Full-bleed Night with the glyph re-centred and scaled about the box centre.
 *
 * At scale 1 the glyph's outer arc reaches r≈56.5 from (84,84). Android's
 * guaranteed-visible circle is r=64 about (80,80), so 0.95 lands the whole mark
 * at r≈54 — inside the safe zone with room to spare, and still large enough to
 * read at 48dp. iOS masks less aggressively, so it gets 1.08.
 */
function fullBleed(scale) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
    `<rect width="160" height="160" fill="${NIGHT}"/>` +
    `<g transform="translate(80 80) scale(${scale}) translate(-84 -84)">${glyph}</g>` +
    '</svg>'
  )
}

/**
 * density scales the SVG rasteriser's internal resolution. libvips renders at
 * 72dpi by default, which for a 160-unit viewBox means a 160px bitmap that is
 * then upscaled to 512 — soft edges on every stroke. Rendering at the target
 * size and resizing down keeps them crisp.
 */
async function emit(markup, size, outPath, { opaque = false } = {}) {
  let pipeline = sharp(Buffer.from(markup), { density: (72 * size) / 160 }).resize(size, size)
  if (opaque) pipeline = pipeline.flatten({ background: NIGHT })
  const png = await pipeline.png({ compressionLevel: 9, palette: false }).toBuffer()
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, png)
  console.log(`wrote ${outPath} (${size}x${size}, ${png.length} bytes)`)
}

const maskable = fullBleed(0.95)
const apple = fullBleed(1.08)

await emit(svg, 192, resolve(publicDir, 'icons/icon-192.png'))
await emit(svg, 512, resolve(publicDir, 'icons/icon-512.png'))
await emit(maskable, 192, resolve(publicDir, 'icons/maskable-192.png'))
await emit(maskable, 512, resolve(publicDir, 'icons/maskable-512.png'))
// 180 is what current iOS asks for; smaller devices downscale it themselves.
await emit(apple, 180, resolve(publicDir, 'apple-touch-icon.png'), { opaque: true })
