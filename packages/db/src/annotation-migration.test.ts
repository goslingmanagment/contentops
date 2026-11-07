import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, runMigrations } from './migrate.ts'
import { createTestDatabase } from './testing/index.ts'
import { journalContext, make, newModel, newPrincipal } from './testing/rows.ts'

/**
 * The late migration of the markup (schema §9.5): on a catalog filled before it, the values,
 * versions, confirmations and sources of the fields, the chronology, the texts and the tags
 * stay as they were; the new links to the runs are empty.
 */

const LATE = '0017_annotation.sql'
const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function migrationsBefore(file: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'contentops-before-annotation-'))
  dirs.push(dir)
  await cp(MIGRATIONS_DIR, dir, {
    recursive: true,
    filter: (source) => !source.endsWith('.sql') || basename(source) < file,
  })
  return dir
}

const TABLES = [
  'content_items',
  'annotation_fields',
  'chronology_entries',
  'platform_texts',
  'item_tags',
] as const

async function snapshot(client: pg.ClientBase): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {}
  for (const table of TABLES) {
    const { rows } = await client.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t.*) AS row FROM ${table} t ORDER BY t.id`,
    )
    out[table] = rows.map((row) => row.row)
  }
  return out
}

describe(LATE, () => {
  it('keeps what the catalog held and leaves the links to the runs empty', async () => {
    const db = await createTestDatabase({ migrated: false })
    await runMigrations({
      databaseUrl: db.url('migrate'),
      appliedBy: 'test',
      migrationsDir: await migrationsBefore(LATE),
    })
    const client = new pg.Client({ connectionString: db.url('migrate') })
    await client.connect()
    try {
      await client.query('BEGIN')
      await journalContext(client, 'test.before_annotation')
      const modelId = await newModel(client)
      const person = await newPrincipal(client)
      const item = await make(client, 'content_items', modelId)
      await client.query(
        `UPDATE content_items SET title = 'Чулки и кружево', title_en = 'Lace stockings',
                description = 'Заметка КМ' WHERE model_id = $1 AND id = $2`,
        [modelId, item.id],
      )
      const version = await make(client, 'asset_versions', modelId)
      // Confirmed by a person, a draft of the import, confirmed empty, a version's chronology.
      await client.query(
        `INSERT INTO annotation_fields (model_id, item_id, field, value_version,
                                        confirmed_value_version, confirmed_at, confirmed_by)
         VALUES ($1, $2, 'title', 3, 3, now(), $3), ($1, $2, 'title_en', 2, NULL, NULL, NULL),
                ($1, $2, 'tags', 0, 0, now(), $3)`,
        [modelId, item.id, person],
      )
      await client.query(
        `INSERT INTO annotation_fields (model_id, version_id, field, value_version,
                                        confirmed_value_version, confirmed_at, confirmed_by)
         VALUES ($1, $2, 'chronology', 1, 1, now(), $3)`,
        [modelId, version.id, person],
      )
      await client.query(
        `INSERT INTO chronology_entries (model_id, item_id, asset_version_id, at_ms, text, source)
         VALUES ($1, $2, $3, 0, 'торт и свечи', 'human'), ($1, $2, $3, 145000, 'бельё', 'import')`,
        [modelId, item.id, version.id],
      )
      await client.query(
        `INSERT INTO platform_texts (model_id, item_id, platform, locale, variant_no, body,
                                     value_version, confirmed_value_version, confirmed_at, source)
         VALUES ($1, $2, 'generic', 'en', 1, 'Wall text', 2, 2, now(), 'import'),
                ($1, $2, 'generic', 'en', 2, 'Message text', 1, NULL, NULL, 'import')`,
        [modelId, item.id],
      )
      const { rows: tags } = await client.query<{ id: string }>(
        `INSERT INTO tags (slug, label_ru) VALUES ('lace-before', 'кружево') RETURNING id`,
      )
      await client.query(
        `INSERT INTO item_tags (model_id, item_id, tag_id, source, group_at_import)
         VALUES ($1, $2, $3, 'import', 'attribute')`,
        [modelId, item.id, tags[0]?.id],
      )
      await client.query('COMMIT')
      const before = await snapshot(client)

      const result = await runMigrations({ databaseUrl: db.url('migrate'), appliedBy: 'test' })
      expect(result.applied.map((file) => file.version)).toEqual([17])

      const after = await snapshot(client)
      const link: Record<string, string | null> = {
        annotation_fields: 'suggested_by_run_id',
        chronology_entries: 'run_id',
        platform_texts: 'run_id',
      }
      for (const table of TABLES) {
        const column = link[table]
        expect(after[table], table).toEqual(
          before[table]?.map((row) => (column ? { ...row, [column]: null } : row)),
        )
        expect(after[table]?.length, table).toBeGreaterThan(0)
      }
    } finally {
      await client.end()
      await db.drop()
    }
  })
})
