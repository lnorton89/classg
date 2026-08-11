import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const bboxText = process.env.CLASSG_TILE_PRELOAD_BBOX?.trim()
if (!bboxText) {
  console.log('satellite preload skipped: CLASSG_TILE_PRELOAD_BBOX is empty')
  process.exit(0)
}

const bbox = bboxText.split(',').map(Number)
if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
  throw new Error('CLASSG_TILE_PRELOAD_BBOX must be west,south,east,north')
}

const [west, south, east, north] = bbox
if (west >= east || south >= north || west < -180 || east > 180 || south < -85 || north > 85) {
  throw new Error('CLASSG_TILE_PRELOAD_BBOX is outside valid Web Mercator bounds')
}

// 19 is the deepest zoom the default source has real pixels for; see
// BASEMAP_MAX_ZOOM in src/features/map/style.ts. Preloading past a source's
// ceiling silently bakes placeholder tiles into the image, so the clamp and
// that constant have to move together.
const minZoom = integerEnv('CLASSG_TILE_PRELOAD_MIN_ZOOM', 12, 0, 19)
const maxZoom = integerEnv('CLASSG_TILE_PRELOAD_MAX_ZOOM', 15, minZoom, 19)
const maxTiles = integerEnv('CLASSG_TILE_PRELOAD_MAX_TILES', 600, 1, 10_000)
const concurrency = integerEnv('CLASSG_TILE_PRELOAD_CONCURRENCY', 8, 1, 32)
const sourceTemplate =
  process.env.CLASSG_SATELLITE_TILE_URL?.trim() ||
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const outputRoot = path.resolve('public/tiles/basemap')

const jobs = [{ z: 0, x: 0, y: 0 }]
for (let z = minZoom; z <= maxZoom; z += 1) {
  const topLeft = tileFor(west, north, z)
  const bottomRight = tileFor(east, south, z)
  for (let x = topLeft.x; x <= bottomRight.x; x += 1) {
    for (let y = topLeft.y; y <= bottomRight.y; y += 1) jobs.push({ z, x, y })
  }
}

const uniqueJobs = [...new Map(jobs.map((job) => [`${job.z}/${job.x}/${job.y}`, job])).values()]
if (uniqueJobs.length > maxTiles) {
  throw new Error(
    `satellite preload would fetch ${uniqueJobs.length} tiles; raise CLASSG_TILE_PRELOAD_MAX_TILES or reduce the bbox/zoom range`,
  )
}

let downloaded = 0
let failed = 0
let cursor = 0

await Promise.all(
  Array.from({ length: Math.min(concurrency, uniqueJobs.length) }, async () => {
    while (cursor < uniqueJobs.length) {
      const job = uniqueJobs[cursor++]
      if (!job) return
      const url = sourceTemplate
        .replace('{z}', String(job.z))
        .replace('{x}', String(job.x))
        .replace('{y}', String(job.y))
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
          headers: { 'User-Agent': 'ClassG satellite tile preloader/0.1' },
        })
        const contentType = response.headers.get('content-type') ?? ''
        if (!response.ok || !contentType.startsWith('image/')) {
          throw new Error(`HTTP ${response.status} ${contentType}`)
        }
        const target = path.join(outputRoot, String(job.z), String(job.x), `${job.y}.jpg`)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(await response.arrayBuffer()))
        downloaded += 1
      } catch (error) {
        failed += 1
        console.warn(`satellite tile ${job.z}/${job.x}/${job.y} skipped: ${error.message}`)
      }
    }
  }),
)

console.log(
  `satellite preload complete: ${downloaded}/${uniqueJobs.length} tiles cached (${failed} unavailable)`,
)

function integerEnv(name, fallback, min, max) {
  const raw = process.env[name]?.trim()
  const value = raw ? Number(raw) : fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

function tileFor(lon, lat, zoom) {
  const scale = 2 ** zoom
  const latRad = (lat * Math.PI) / 180
  return {
    x: Math.floor(((lon + 180) / 360) * scale),
    y: Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale,
    ),
  }
}
