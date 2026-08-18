/**
 * Turn deployment and watchdog polling into log entries, once per app.
 *
 * Mounted in the shell rather than on the admin page on purpose: a deploy
 * landing or the watchdog giving up is not admin-page news, it is news. An
 * operator watching the map should learn that the unit just restarted its
 * sensors without having to be on the page that happens to poll for it.
 *
 * Only an admin can read either endpoint, so for everybody else this is inert
 * -- the queries are disabled rather than left to 403 in the background.
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { useHasRole } from '@/features/auth/use-auth'
import { log } from '@/features/logs/log-store'
import { deploymentQuery, watchdogQuery } from '@/lib/api/queries'

import { deploymentEvents, watchdogEvents, type UnitMemo } from './unit-events'

export function useUnitEvents(): void {
  const isAdmin = useHasRole('admin')
  const memo = useRef<UnitMemo>({})

  const deployment = useQuery({ ...deploymentQuery(), enabled: isAdmin })
  const watchdog = useQuery({ ...watchdogQuery(), enabled: isAdmin })

  useEffect(() => {
    const result = deploymentEvents(memo.current, deployment.data)
    memo.current = result.memo
    for (const event of result.events) {
      log.entry({
        level: event.level,
        source: 'deploy',
        message: event.message,
        detail: event.detail,
      })
    }
  }, [deployment.data])

  useEffect(() => {
    const result = watchdogEvents(memo.current, watchdog.data)
    memo.current = result.memo
    for (const event of result.events) {
      log.entry({
        level: event.level,
        source: 'deploy',
        message: event.message,
        detail: event.detail,
      })
    }
  }, [watchdog.data])
}
