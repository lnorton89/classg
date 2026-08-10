import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { LiveProvider } from '@/app/live-provider'
import { ThemeProvider } from '@/app/theme'
import { USE_MSW } from '@/lib/env'
import { routeTree } from '@/routeTree.gen'

import '@/styles.css'
import 'maplibre-gl/dist/maplibre-gl.css'

const queryClient = new QueryClient({
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
        <QueryClientProvider client={queryClient}>
          <LiveProvider>
            <RouterProvider router={router} />
          </LiveProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}

void start()
