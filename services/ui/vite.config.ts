import { fileURLToPath, URL } from 'node:url'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * ClassG web app — static SPA.
 *
 * The build output (`services/ui/dist`) is served by the Go `api` binary. There is
 * no Node runtime on the Pi, so nothing here may depend on server-side rendering.
 * See docs/architecture/ui-design.md for why TanStack Start was rejected.
 *
 * Dev works with no backend: MSW intercepts everything. Set VITE_USE_MSW=false to
 * develop against a real API, in which case the proxy below forwards /api to it.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, 'VITE_')

  return {
    envDir: repoRoot,
    plugins: [
      // Must precede react() — it generates src/routeTree.gen.ts.
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
    ],

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    server: {
      port: 5173,
      proxy: {
        // Only reached when VITE_USE_MSW=false; MSW intercepts before the network
        // otherwise. Kept here so pointing at a real Pi is a one-env-var change.
        '/api': {
          target: env['VITE_API_TARGET'] ?? 'http://localhost:8081',
          changeOrigin: true,
          ws: true,
        },

        // Satellite basemap. In production nginx serves these, falling back to
        // Esri World Imagery and caching the result (services/ui/nginx.conf).
        // The dev server has no nginx, so without this the map loads with no
        // satellite background at all -- which looks like a broken basemap
        // rather than a missing proxy.
        //
        // The path deliberately mirrors nginx's, including the z/y/x reorder:
        // our tiles are addressed {z}/{x}/{y} and the ArcGIS endpoint expects
        // {z}/{y}/{x}. Dev and production must request the identical URL or the
        // cache built for one is useless to the other.
        //
        // A REGEX, matching nginx's `location ~ ^/tiles/basemap/…\.jpg$`
        // exactly, because a Vite proxy key is a PREFIX. As a prefix this
        // swallowed everything under /tiles/basemap*, including
        // /tiles/basemap.pmtiles — the vector archive was forwarded to ArcGIS
        // and came back as their 404, so the map silently fell through to the
        // raster path in dev while working in production. Dev and prod
        // disagreeing about which requests are proxied is the whole failure.
        '^/tiles/basemap/\\d+/\\d+/\\d+\\.jpg$': {
          target: env['VITE_SATELLITE_TILE_ORIGIN'] ?? 'https://services.arcgisonline.com',
          changeOrigin: true,
          rewrite: (path: string) => {
            const m = /^\/tiles\/basemap\/(\d+)\/(\d+)\/(\d+)\.jpg$/.exec(path)
            if (!m) return path
            const [, z, x, y] = m
            return `/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
          },
        },
      },
    },

    build: {
      outDir: 'dist',
      sourcemap: true,
      // Vite 8 default target is 'baseline-widely-available'. maplibre-gl v6 needs
      // WebGL2, which implies a browser newer than that baseline anyway.
      rolldownOptions: {
        output: {
          manualChunks(id) {
            // ~800 kB of the bundle. Splitting it keeps the shell interactive on a
            // phone over the Pi's AP before the map finishes loading.
            if (/[\\/]node_modules[\\/]maplibre-gl[\\/]/.test(id)) return 'maplibre'
          },
        },
      },
    },
  }
})
