import { fileURLToPath, URL } from 'node:url'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

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

      /*
       * PWA. `injectManifest` rather than `generateSW`: the routing policy in
       * src/sw.ts is the point of this whole feature (the API is never cached,
       * and nginx's offline tile placeholder must not be), and generateSW's
       * config is serialised into a generated file, so it cannot express a
       * `cacheWillUpdate` predicate. All this plugin does here is hash the build
       * output into `self.__WB_MANIFEST` and bundle that file.
       *
       * `manifest: false` — public/site.webmanifest is hand-maintained and
       * already linked from index.html; letting the plugin generate a second one
       * is how the two silently disagree.
       *
       * `injectRegister: null` — registration is ours (src/app/register-sw.ts)
       * so it can be gated on MSW, on a secure context, and on a preference.
       *
       * No devOptions: a service worker in dev would race MSW's worker for the
       * same scope, and whichever won, the other's interception would vanish.
       */
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        manifest: false,
        injectRegister: null,
        injectManifest: {
          globPatterns: ['**/*.{html,css,js,svg,png,ico,woff2,webmanifest}'],
          globIgnores: [
            // MSW's worker. It ships in the image because it lives in public/,
            // but it is a dev fixture and precaching it would pin a stale copy
            // of somebody else's service worker into our cache.
            'mockServiceWorker.js',
            // The pmtiles archives are ~46 MB and are read with range requests;
            // basemap/** is whatever the optional preload baked in. Neither
            // belongs in a precache the browser must fetch in full on install.
            'tiles/**',
          ],
          // The maplibre chunk is ~800 kB. Workbox's 2 MB default would drop a
          // future larger one silently, and a precache missing the map is worse
          // than no precache at all.
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
      }),
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
      // 'hidden' rather than true: the maps are still produced, so a stack
      // trace can be symbolicated from a build artifact, but no
      // sourceMappingURL comment ships -- and the runtime image drops the .map
      // files entirely (see Dockerfile). They were the largest thing in the
      // image at ~4.7 MB, served publicly, and they hand a reader the whole
      // unminified source of a security tool.
      sourcemap: 'hidden',
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
