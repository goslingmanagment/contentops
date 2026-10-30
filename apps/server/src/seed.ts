import { createDb, createPool } from '@contentops/db'
import { seedCatalog } from './testing/catalog-seed'

/**
 * `contentops seed [model]` — a fictional catalog for the dev stand and the pilot VM before
 * stage 3 (PLAN 2а): `DATABASE_URL` of the app role, the model code (default `lora`). A model
 * that already has objects is left as it is. Never for a database with real content.
 */
const url = process.env.DATABASE_URL
if (!url) {
  console.error('seed: set DATABASE_URL')
  process.exit(2)
}
const model = process.argv[2] ?? 'lora'
const pool = createPool(url, { max: 2, applicationName: 'seed' })
try {
  const result = await seedCatalog(createDb(pool), model)
  console.log(
    result.skipped
      ? `seed: ${model} already has objects, nothing to do`
      : `seed: ${model} — ${result.created} objects`,
  )
} finally {
  await pool.end()
}
