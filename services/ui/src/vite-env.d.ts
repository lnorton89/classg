/**
 * Build-time environment variables.
 *
 * Vite's own `ImportMetaEnv` is `[key: string]: any`, so every
 * `import.meta.env.VITE_*` read is an untyped hole that lands in application
 * code as `any`. Declaring the ones this app actually uses closes it — the
 * members below win over the index signature by declaration merging — and
 * makes the set of switches a build responds to readable in one place.
 *
 * All optional and all `string`: an unset variable is `undefined`, and Vite
 * substitutes text, so `VITE_USE_MSW=false` is the five-character string and
 * never a boolean.
 */
interface ImportMetaEnv {
  /** `false` disables MSW and points the app at a real API through the proxy. */
  readonly VITE_USE_MSW?: string
  /** Where the dev proxy forwards `/api`. Dev only. */
  readonly VITE_API_TARGET?: string
  /** Upstream the dev proxy rewrites `/tiles/basemap` onto. Dev only. */
  readonly VITE_SATELLITE_TILE_ORIGIN?: string
  /** A `.pmtiles` archive, or any MapLibre style URL. See features/map/style.ts. */
  readonly VITE_BASEMAP_VECTOR_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
