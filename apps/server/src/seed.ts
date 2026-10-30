import { createDb, createPool } from '@contentops/db'
import { BlobStore } from './media/storage'
import type { FixtureItem } from './testing/catalog-factory'
import { seedCatalog } from './testing/catalog-seed'
import { seedFullCatalog } from './testing/full-catalog'
import { enqueueSeedRenditions, prepareSeedMedia, withSeedMedia } from './testing/media-seed'
import { seedPlan } from './testing/plan-seed'

/**
 * `contentops seed [model] [--media] [--plan] [--full]` — a fictional catalog for the dev stand
 * and the pilot VM before stage 3 (PLAN 2а): `DATABASE_URL` of the app role, the model code
 * (default `lora`). With `--media` the files get real bytes drawn by FFmpeg and sharp (test
 * patterns, no people; `DATA_ROOT`, `DERIVED_ROOT`, `TMP_ROOT` needed) and the worker roles
 * build their renditions. With `--plan` a week of the plan and the content manager Диана
 * (`diana`, the password of `CONTENTOPS_OWNER_PASSWORD`) for the screens of 4а. `--full` — the
 * full-volume catalog of DESIGN §9.3 (1 391 objects with placements) for the interface
 * measurement in its own test database (`tools/perf/`). A model that already has objects
 * (rows) is left as it is. Never for a database with real content.
 */
const url = process.env.DATABASE_URL
if (!url) {
  console.error('seed: set DATABASE_URL')
  process.exit(2)
}
const args = process.argv.slice(2)
const withMedia = args.includes('--media')
const withPlan = args.includes('--plan')
const full = args.includes('--full')
const model = args.find((arg) => !arg.startsWith('--')) ?? 'lora'
const pool = createPool(url, { max: 2, applicationName: 'seed' })
try {
  const db = createDb(pool)
  let media: Awaited<ReturnType<typeof prepareSeedMedia>> | null = null
  if (withMedia) {
    const { DATA_ROOT, DERIVED_ROOT, TMP_ROOT } = process.env
    if (!DATA_ROOT || !DERIVED_ROOT || !TMP_ROOT) {
      console.error('seed --media: set DATA_ROOT, DERIVED_ROOT and TMP_ROOT')
      process.exit(2)
    }
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM content_items i JOIN models m ON m.id = i.model_id WHERE m.code = $1',
      [model],
    )
    if ((rows[0]?.n ?? 0) === 0) {
      const store = new BlobStore({
        dataRoot: DATA_ROOT,
        derivedRoot: DERIVED_ROOT,
        tmpRoot: TMP_ROOT,
      })
      // The full catalog spreads its covers over more drawn files.
      media = await prepareSeedMedia(db, store, full ? { videos: 24, photos: 48, seconds: 4 } : {})
    }
  }
  const prepared = media
  const options: { media?: (items: readonly FixtureItem[]) => FixtureItem[] } = prepared
    ? { media: (items) => withSeedMedia(items, prepared) }
    : {}
  const result = full
    ? await seedFullCatalog(db, model, options)
    : await seedCatalog(db, model, options)
  if (prepared && !result.skipped) {
    const works = await enqueueSeedRenditions(db, model, prepared)
    console.log(`seed: ${works} rendition works for the worker roles`)
  }
  console.log(
    result.skipped
      ? `seed: ${model} already has objects, nothing to do`
      : `seed: ${model} — ${result.created} objects${prepared ? ' with real media' : ''}`,
  )
  if (withPlan) {
    const plan = await seedPlan(
      db,
      model,
      process.env.CONTENTOPS_OWNER_PASSWORD ?? 'contentops-dev',
    )
    console.log(
      plan.skipped
        ? `seed: ${model} already has a plan, nothing to do`
        : `seed: ${model} — ${plan.rows} plan rows, content manager diana`,
    )
  }
} finally {
  await pool.end()
}
