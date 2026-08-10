import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Deliberately separate from vite.config.ts: the TanStack Router plugin does
 * codegen and file watching that tests neither need nor benefit from, and the
 * generated route tree is committed so tests can import it directly.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: true,
    // happy-dom over jsdom: ~2-4x faster, and jsdom 30 requires Node >= 22.22,
    // which is newer than the floor we want CI and the Pi to share.
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    exclude: [...configDefaults.exclude, '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/routeTree.gen.ts',
        'src/lib/api/schema.gen.ts',
        'src/mocks/**',
        'src/test/**',
      ],
    },
  },
})
