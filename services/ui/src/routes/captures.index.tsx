import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/captures/')({
  beforeLoad: () => {
    return redirect({ to: '/sensors', hash: 'captures' })
  },
})
