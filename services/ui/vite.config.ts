import { fileURLToPath, URL } from 'node:url'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
export default defineConfig({
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
        target: process.env['VITE_API_TARGET'] ?? 'http://localhost:8081',
        changeOrigin: true,
        ws: true,
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
})
