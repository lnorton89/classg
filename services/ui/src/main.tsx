import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { LiveProvider } from '@/app/live-provider'
import { PreferencesProvider } from '@/app/preferences'
import { ThemeProvider } from '@/app/theme'
import { RoutePending } from '@/components/layout/route-pending'
import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { log } from '@/features/logs/log-store'
import { ApiError } from '@/lib/api/client'
import { USE_MSW } from '@/lib/env'
import { routeTree } from '@/routeTree.gen'

/*
 * Fonts are bundled, never fetched from a CDN. This runs on a Pi that may have
 * no route to the internet at all, and a console whose type falls back to
 * Times New Roman in the field is a console nobody trusts.
 *
 * Inter and JetBrains Mono are variable (one file, every weight) and keep their
 * full subset coverage: they render data we do not control — an SSID or a
 * vendor string can be Cyrillic — and each subset only downloads if a character
 * in its unicode-range is actually used.
 *
 * Manrope is the display face and only ever sets our own English UI strings, so
 * the latin subset is enough. Three static weights: 600 and 700 for headings,
 * 800 for the wordmark's ExtraBold, which the browser had been faking.
 */
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import '@/styles.css'
import 'maplibre-gl/dist/maplibre-gl.css'

/** Any API failure, wherever it happens, becomes one line in the event log. */
function logApiFailure(error: unknown, context: string): void {
  if (error instanceof ApiError) {
    log.error('api', `${context}: ${error.message}`, {
      code: error.code,
      status: error.status,
      ...(error.field ? { field: error.field } : {}),
    })
    return
  }
  log.error('api', `${context}: ${error instanceof Error ? error.message : String(error)}`)
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) =>
      logApiFailure(error, `Request failed (${String(query.queryKey[0])})`),
  }),
  mutationCache: new MutationCache({
    onError: (error) => logApiFailure(error, 'Action failed'),
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
  // Without a pending component the router renders NOTHING while a loader is
  // in flight -- no shell, no navigation, just white. Fine on a desk, wrong on
  // the Pi: the one screen this console must never show by accident is a blank
  // one, because that is also what a dead sensor looks like.
  //
  // 250ms before showing it, held for at least 300ms once shown. Below that a
  // fast navigation flashes the spinner, which reads as jank rather than
  // progress; above it the blank period gets long enough to look broken.
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 250,
  defaultPendingMinMs: 300,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

async function start(): Promise<void> {
  if (USE_MSW) {
    const { worker } = await import('@/mocks/browser')
    await worker.start({ onUnhandledRequest: 'bypass' })
  }

  const root = document.getElementById('root')
  if (!root) throw new Error('Missing #root application mount')

  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <PreferencesProvider>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <ToastProvider>
                <LiveProvider>
                  <RouterProvider router={router} />
                </LiveProvider>
              </ToastProvider>
            </TooltipProvider>
          </QueryClientProvider>
        </PreferencesProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}

void start()
