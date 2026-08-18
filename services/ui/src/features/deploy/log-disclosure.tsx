import type { ReactNode } from 'react'

/** A run's log, collapsed behind a summary so it does not dominate the card
 *  it sits in. Shared by the deployment and watchdog panels — same shape,
 *  same reason to change, only the source array and the label differ. */
export function LogDisclosure({
  log,
  summary,
}: {
  log: string[] | undefined
  summary: ReactNode
}) {
  if (!log || log.length === 0) return null

  return (
    <details>
      <summary className="text-muted-foreground cursor-pointer text-2xs">{summary}</summary>
      <pre className="bg-muted/40 mt-2 max-h-64 overflow-auto rounded-md p-2 font-mono text-2xs whitespace-pre-wrap">
        {log.join('\n')}
      </pre>
    </details>
  )
}
