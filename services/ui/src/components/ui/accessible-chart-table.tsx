import { useState } from 'react'
import type { ReactNode } from 'react'

export interface ChartTableColumn<T> {
  key: string
  label: ReactNode
  render: (row: T) => ReactNode
  className?: string
}

/**
 * The accessible twin of a hand-rolled SVG chart: the same rows, as a table,
 * collapsed behind a summary so it does not compete with the plot above it.
 *
 * `lazy` skips rendering the body until the details element is opened —
 * worth it for a history table that can hold thousands of samples, and
 * skippable for the common case of a few dozen.
 */
export function AccessibleChartTable<T>({
  columns,
  rows,
  rowKey,
  summary,
  lazy = false,
  className,
}: {
  columns: ChartTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  summary: ReactNode
  lazy?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const renderBody = !lazy || open

  return (
    <details
      className={className}
      onToggle={lazy ? (e) => setOpen(e.currentTarget.open) : undefined}
    >
      <summary className="text-muted-foreground cursor-pointer text-2xs">{summary}</summary>
      {renderBody ? (
        <div className="mt-1 max-h-64 overflow-auto [scrollbar-gutter:stable_both-edges]">
          <table className="w-full text-left text-2xs">
            <thead className="text-muted-foreground">
              <tr>
                {columns.map((column) => (
                  <th key={column.key} scope="col" className="py-1 pr-3 font-medium">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.className ?? 'py-0.5 pr-3'}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  )
}
