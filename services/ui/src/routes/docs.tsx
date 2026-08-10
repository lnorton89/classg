import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { ChevronDownIcon, FileTextIcon, FolderOpenIcon, FolderTreeIcon } from 'lucide-react'

import { cn } from '@/lib/cn'

import guide from '../../../../docs/operator-guide.json'

type GuideDocument = (typeof guide.documents)[number]

type TreeNode = {
  name: string
  children: Map<string, TreeNode>
  document?: GuideDocument
}

export const Route = createFileRoute('/docs')({ component: DocsLayout })

function buildDocumentationTree() {
  const root: TreeNode = { name: 'classg', children: new Map() }

  for (const document of guide.documents) {
    let parent = root
    for (const segment of document.treePath) {
      let child = parent.children.get(segment)
      if (!child) {
        child = { name: segment, children: new Map() }
        parent.children.set(segment, child)
      }
      parent = child
    }
    parent.document = document
  }

  return root
}

const documentationTree = buildDocumentationTree()

function TreeBranch({ node, depth }: { node: TreeNode; depth: number }) {
  const children = [...node.children.values()]

  if (children.length === 0 && node.document) {
    return (
      <li>
        <Link
          to="/docs/$docId"
          params={{ docId: node.document.id }}
          title={node.document.title}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex min-h-8 items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors"
          activeProps={{ className: 'bg-primary/10 text-primary font-medium' }}
        >
          <FileTextIcon className="size-3.5 shrink-0" aria-hidden />
          <span>{node.name}</span>
        </Link>
      </li>
    )
  }

  return (
    <li>
      <details open>
        <summary
          className={cn(
            'group text-foreground hover:bg-muted flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md px-2 py-1 font-mono text-xs',
            depth === 0 && 'font-semibold',
          )}
        >
          <ChevronDownIcon
            className="size-3.5 shrink-0 -rotate-90 transition-transform group-open:rotate-0"
            aria-hidden
          />
          <FolderOpenIcon className="text-primary size-3.5 shrink-0" aria-hidden />
          <span>{node.name}/</span>
        </summary>
        <ul className="border-border ml-3.5 space-y-0.5 border-l pl-2">
          {children.map((child) => (
            <TreeBranch key={child.name} node={child} depth={depth + 1} />
          ))}
        </ul>
      </details>
    </li>
  )
}

export function DocsTree() {
  return (
    <nav aria-label="Repository documentation">
      <ul>
        <TreeBranch node={documentationTree} depth={0} />
      </ul>
    </nav>
  )
}

function DocsLayout() {
  return (
    <div className="mx-auto grid w-full max-w-[90rem] gap-4 p-3 lg:grid-cols-[17rem_minmax(0,1fr)] lg:p-4">
      <aside className="border-border bg-card/70 self-start rounded-lg border p-3 lg:sticky lg:top-20">
        <div className="mb-3 flex items-center gap-2 px-2">
          <FolderTreeIcon className="text-primary size-4" aria-hidden />
          <div>
            <p className="text-sm font-semibold">Repository</p>
            <p className="text-muted-foreground text-[11px]">Documentation explorer</p>
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto pr-1 lg:max-h-[calc(100vh-10rem)]">
          <DocsTree />
        </div>
      </aside>

      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  )
}
