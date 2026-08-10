import { createFileRoute } from '@tanstack/react-router'
import { BookOpenIcon, FileTextIcon, TerminalIcon } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/misc'

import guide from '../../../../docs/operator-guide.json'

export type GuideDocument = (typeof guide.documents)[number]

export const Route = createFileRoute('/docs/$docId')({ component: DocsDocumentRoute })

function sectionAnchor(title: string) {
  return `section-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}`
}

function DocsDocumentRoute() {
  const { docId } = Route.useParams()
  const document = guide.documents.find((candidate) => candidate.id === docId)

  if (!document) {
    return (
      <div className="p-6">
        <Alert tone="info" title="Documentation topic not found">
          Return to the documentation index to choose an available component.
        </Alert>
      </div>
    )
  }

  return <DocsDocument document={document} />
}

export function DocsDocument({ document }: { document: GuideDocument }) {
  const architecture = document.sections.find((section) =>
    section.title.startsWith('Architecture'),
  )
  const environment = document.sections.find(
    (section) => section.title === 'Environment variables',
  )
  const bodySections = document.sections.filter(
    (section) => section !== architecture && section !== environment,
  )
  const contentSections = environment ? [...bodySections, environment] : bodySections

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-3 sm:p-4">
      <header>
        <div className="border-border bg-card/60 rounded-lg border p-5 sm:p-6">
          <p className="text-primary mb-2 flex items-center gap-2 font-mono text-xs">
            <BookOpenIcon className="size-4" aria-hidden /> {document.area}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{document.title}</h1>
          <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-6">
            {document.summary}
          </p>
          {architecture ? (
            <div className="border-border mt-5 border-t pt-4">
              <h2 className="text-sm font-semibold">Architecture</h2>
              <p className="text-muted-foreground mt-1 text-xs leading-5">
                {architecture.description}
              </p>
              <dl className="mt-3 grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                {architecture.items.map((item) => (
                  <div key={item.title} className="text-xs leading-5">
                    <dt className="font-medium">{item.title}</dt>
                    <dd className="text-muted-foreground">{item.body}</dd>
                    {'path' in item ? (
                      <dd>
                        <code className="bg-muted rounded px-1 py-0.5 text-[11px]">
                          {item.path}
                        </code>
                      </dd>
                    ) : null}
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </header>

      {contentSections.length > 1 ? (
        <nav aria-label="On this page" className="flex flex-wrap gap-2">
          {contentSections.map((section) => (
            <a
              key={section.title}
              href={`#${sectionAnchor(section.title)}`}
              className="border-border bg-card text-muted-foreground hover:text-foreground rounded-full border px-3 py-1 text-xs"
            >
              {section.title}
            </a>
          ))}
        </nav>
      ) : null}

      <div className="space-y-8">
        {contentSections.map((section) => (
          <section
            key={section.title}
            id={sectionAnchor(section.title)}
            className="scroll-mt-20"
          >
            <div className="mb-3">
              <h2 className="text-lg font-semibold tracking-tight">{section.title}</h2>
              <p className="text-muted-foreground mt-1 text-sm">{section.description}</p>
            </div>

            {section === environment ? (
              <Card>
                <CardContent className="p-4">
                  <dl className="divide-border divide-y">
                    {section.items.map((item) => (
                      <div
                        key={item.title}
                        className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4"
                      >
                        <dt className="text-sm font-medium">{item.title}</dt>
                        <dd className="text-muted-foreground text-xs leading-5">
                          {item.body}
                          {'path' in item ? (
                            <code className="bg-muted text-foreground ml-2 inline-block rounded px-1.5 py-0.5 text-[11px]">
                              {item.path}
                            </code>
                          ) : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3">
                {section.items.map((item) => (
                  <Card key={item.title}>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        {'command' in item ? (
                          <TerminalIcon className="text-primary size-4" aria-hidden />
                        ) : (
                          <FileTextIcon className="text-muted-foreground size-4" aria-hidden />
                        )}
                        {item.title}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-muted-foreground text-sm leading-6">{item.body}</p>
                      {'command' in item ? (
                        <pre className="border-border bg-background overflow-x-auto rounded-md border p-3 text-xs leading-5">
                          <code>{item.command}</code>
                        </pre>
                      ) : null}
                      {'path' in item ? (
                        <code className="bg-muted text-foreground inline-block rounded px-2 py-1 text-xs">
                          {item.path}
                        </code>
                      ) : null}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
