/**
 * Generate TypeScript types from the normative JSON Schemas in `schemas/`.
 *
 * The schemas are the cross-language contract (ADR-0001). Hand-writing a TS copy
 * guarantees drift, and drift in a drone detector is silent: the UI renders a
 * plausible wrong thing rather than failing. So we generate, commit the output,
 * and let CI fail if the committed file no longer matches the schemas.
 *
 *   npm run gen:types        regenerate src/lib/api/schema.gen.ts
 *   npm run gen:types:check  fail if it is stale (used by lint + CI)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'json-schema-to-typescript'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const schemaDir = resolve(repoRoot, 'schemas')
const outFile = resolve(here, '../src/lib/api/schema.gen.ts')

const SOURCES = [
  { file: 'track.schema.json', name: 'Track' },
  { file: 'detection.schema.json', name: 'Detection' },
]

const BANNER = `/* eslint-disable */
/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Derived from the normative JSON Schemas in \`schemas/\`.
 * Regenerate with: npm run gen:types
 */
`

const options = {
  bannerComment: '',
  additionalProperties: false,
  style: { semi: false, singleQuote: true },
  enableConstEnums: false,
  declareExternallyReferenced: true,
  unreachableDefinitions: false,
}

async function build() {
  const parts = [BANNER]
  for (const { file, name } of SOURCES) {
    const schema = JSON.parse(readFileSync(resolve(schemaDir, file), 'utf8'))
    const ts = await compile(schema, name, options)
    parts.push(ts.trim(), '')
  }
  return parts.join('\n')
}

const generated = await build()

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(outFile, 'utf8')
  } catch {
    /* missing counts as stale */
  }
  if (current !== generated) {
    console.error(
      'schema.gen.ts is out of date with schemas/*.schema.json.\n' +
        'Run `npm run gen:types` in services/ui and commit the result.',
    )
    process.exit(1)
  }
  console.log('schema.gen.ts is up to date with schemas/*.schema.json')
} else {
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, generated)
  console.log(`wrote ${outFile}`)
}
