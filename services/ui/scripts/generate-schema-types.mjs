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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'json-schema-to-typescript'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const schemaDir = resolve(repoRoot, 'schemas')
const outFile = resolve(here, '../src/lib/api/schema.gen.ts')

// The exported TS name for each schema. Kept explicit because the name is part
// of the app's API surface, not something to derive from a filename.
const TYPE_NAMES = {
  'track.schema.json': 'Track',
  'detection.schema.json': 'Detection',
  'heartbeat.schema.json': 'Heartbeat',
}

// Enumerated from disk rather than listed, because the listed version silently
// ignored a schema that was added to schemas/ and still reported "schema.gen.ts
// is up to date with schemas/*.schema.json" -- a glob claim made from a
// hardcoded pair. heartbeat.schema.json sat unrepresented in TypeScript for
// exactly as long as nobody thought to look.
//
// A new schema now fails loudly here until someone decides what it is called,
// which is the point: the schemas are the four-language contract, and the whole
// reason this file is generated is that a missing type is invisible.
const SOURCES = readdirSync(schemaDir)
  .filter((f) => f.endsWith('.schema.json'))
  .sort()
  .map((file) => {
    const name = TYPE_NAMES[file]
    if (!name) {
      throw new Error(
        `${file} has no entry in TYPE_NAMES in ${'scripts/generate-schema-types.mjs'}.
` +
          'Add one so the schema is represented in TypeScript, or the UI is ' +
          'working from a contract it cannot see.',
      )
    }
    return { file, name }
  })

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
