/**
 * Manual live check of the Hub client — read-only, never in CI. Prints counts, field names
 * and the check's reasons only: no captions, file names, refs or keys.
 *
 *   set -a; . ~/.config/agency/secrets.env; set +a
 *   node packages/hub/scripts/live-smoke.ts [--page lora-1] [--limit 20] [--updated-since-hours 3]
 *
 * The key comes from CONTENTOPS_HUB_KEY, else HUB_AGENT_KEY; the address from
 * CONTENTOPS_HUB_URL, else HUB_BASE_URL. It calls `capabilities`, checks the pinned fields
 * and reads ONE page of `posts` of the page — with `--updated-since-hours`, as the hourly
 * poll does (`rowUpdatedAt` later than now minus that).
 */
import { parseArgs } from 'node:util'
import { checkCapabilities, createHubClient, describeProblem, HUB_DATASETS } from '../src/index.ts'

const { values } = parseArgs({
  options: {
    page: { type: 'string', default: 'lora-1' },
    limit: { type: 'string', default: '20' },
    'updated-since-hours': { type: 'string' },
  },
})

const key = process.env.CONTENTOPS_HUB_KEY ?? process.env.HUB_AGENT_KEY
const baseUrl = process.env.CONTENTOPS_HUB_URL ?? process.env.HUB_BASE_URL
if (!key || !baseUrl) {
  console.error('set CONTENTOPS_HUB_KEY / HUB_AGENT_KEY and CONTENTOPS_HUB_URL / HUB_BASE_URL')
  process.exit(2)
}

const client = createHubClient({
  baseUrl,
  key,
  retry: { attempts: 2, baseDelayMs: 1_000, maxDelayMs: 5_000 },
})

const caps = await client.capabilities()
const granted = [...(caps.grants ?? new Map())].filter(([, g]) => g).map(([c]) => c)
console.log(
  `capabilities: planeMode ${caps.planeMode}, ${caps.datasets.size} datasets in the catalog, ` +
    `${caps.pages.length} pages granted, rights: ${granted.join(', ') || '—'}`,
)
const check = checkCapabilities(caps)
for (const d of HUB_DATASETS) {
  const r = check.datasets[d]
  const declared = caps.datasets.get(d)?.fields.size ?? 0
  console.log(
    `  ${d}: ${r.ok ? 'ok' : r.problems.map((p) => describeProblem(d, p)).join('; ')} ` +
      `(${declared} fields declared)`,
  )
}
console.log(
  `publishing: ${check.publishing.ok ? 'ok' : `missing ${check.publishing.missing.join(', ')}`}`,
)

const hours = values['updated-since-hours']
const reader = client.readDataset('posts', {
  page: values.page,
  limit: Number(values.limit),
  ...(hours ? { updatedSince: new Date(Date.now() - Number(hours) * 3_600_000) } : {}),
})
const first = await reader.next()
await reader.return()
const page = first.value
if (page) {
  const fieldNames = new Set(page.rows.flatMap((r) => Object.keys(r.fields)))
  const nulls = Object.fromEntries(
    [...fieldNames].map((f) => [f, page.rows.filter((r) => r.fields[f] === null).length]),
  )
  console.log(
    `posts of ${values.page}: ${page.rows.length} rows, more: ${page.nextCursor !== null}, ` +
      `blockers: ${page.blockers.join(', ') || '—'}`,
  )
  console.log(`  fields: ${[...fieldNames].sort().join(', ')}`)
  console.log(`  null per field: ${JSON.stringify(nulls)}`)
}
