import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'
import { factory, insert, journalContext, newModel } from './testing/rows.ts'
import { dbErrorCodes } from './values.ts'

/**
 * Structural rules over pg_catalog (schema §1 p. 1, §9.2, §9.4). They hold for every later
 * migration: a new table must be classified here, a new composite FK needs a row factory
 * (`testing/rows.ts`).
 */

/** Tables without `model_id`: no content of a model in them (people, bytes, derivatives). */
const GLOBAL_TABLES = [
  'api_tokens',
  'blob_phashes',
  'blob_probes',
  'blobs',
  'master_checks',
  'models',
  'pipeline_versions',
  'principals',
  'rendition_artifacts',
  'rendition_generations',
  'schema_migrations',
  'sessions',
  'storage_operations',
]
/** Tables where `model_id` may be empty (system-wide rows, shared tags); their key is `id`. */
const OPTIONAL_MODEL_TABLES = [
  'action_log',
  'idempotency_keys',
  'policy_settings',
  'tags',
  'work_operations',
]
/**
 * Mutable tables without the journal trigger: their journal is typed events (schema §9.3) —
 * work, people and tokens, and the global technical tables that workers write.
 */
const NO_JOURNAL = [
  'api_tokens',
  'blob_phashes',
  'blob_probes',
  'blobs',
  'idempotency_keys',
  'master_checks',
  'pipeline_versions',
  'principals',
  'rendition_artifacts',
  'rendition_generations',
  'schema_migrations',
  'sessions',
  'storage_operations',
  'work_operations',
]
/** Append-only tables (schema §9.4): `forbid_update_delete()` and no UPDATE/DELETE for the app. */
const APPEND_ONLY = [
  'action_log',
  'asset_manifest_entries',
  'asset_manifests',
  'asset_versions',
  'custom_order_deliveries',
  'download_receipt_entries',
  'download_receipts',
  'placement_evidence',
]
/** Rows that are updated but never deleted by the app role. */
const NO_DELETE = ['blobs']
/** Columns that never change (`forbid_change`). */
const FIXED_COLUMNS: Record<string, string[]> = {
  accounts: ['model_id', 'id'],
  aliases: ['model_id', 'id', 'kind', 'value_raw'],
  annotation_fields: ['model_id', 'id', 'field'],
  assets: [
    'model_id',
    'id',
    'created_in_item_id',
    'media_kind',
    'variant_kind',
    'variant_no',
    'uniq_level',
  ],
  blobs: ['sha256', 'byte_size', 'ext', 'media_kind', 'storage_key'],
  chronology_entries: ['model_id', 'id', 'item_id', 'asset_version_id'],
  content_items: ['model_id', 'id', 'type', 'number'],
  custom_order_messages: ['model_id', 'id', 'order_id'],
  custom_order_revisions: ['model_id', 'id', 'order_id'],
  custom_orders: ['model_id', 'id'],
  id_counters: ['model_id', 'type'],
  inbox_draft_candidates: [
    'model_id',
    'id',
    'draft_id',
    'kind',
    'order_id',
    'item_id',
    'version_id',
  ],
  inbox_drafts: [
    'model_id',
    'id',
    'source_revision_id',
    'web_upload_id',
    'from_version_id',
    'origin',
  ],
  inbox_groups: ['model_id', 'id', 'source_id', 'group_key'],
  item_memberships: ['model_id', 'id', 'item_id', 'item_type', 'asset_id', 'variant_no', 'kind'],
  item_tags: ['model_id', 'item_id', 'tag_id', 'id'],
  legacy_claims: [
    'model_id',
    'id',
    'source_object_id',
    'source_revision_id',
    'parser_version',
    'claim_key',
    'raw_fragment',
    'claim_kind',
  ],
  legacy_number_claims: [
    'model_id',
    'id',
    'type',
    'claimed_number',
    'source_object_id',
    'claim_id',
  ],
  pipeline_versions: [
    'version',
    'ffmpeg',
    'svtav1',
    'libvips',
    'sharp',
    'phash_algo',
    'master_recipe',
    'rendition_recipes',
    'recipe_digests',
  ],
  placement_assets: ['model_id', 'id', 'placement_id', 'asset_id', 'asset_version_id'],
  placements: ['model_id', 'id', 'account_id', 'surface_id'],
  platform_texts: ['model_id', 'id', 'item_id', 'platform', 'account_id', 'locale', 'variant_no'],
  policy_settings: ['model_id', 'account_id', 'item_type', 'key'],
  posting_plan_rows: [
    'model_id',
    'id',
    'release_id',
    'release_surface_kind',
    'created_at',
    'created_by',
  ],
  ppv_releases: ['model_id', 'id', 'account_id', 'item_id', 'item_type'],
  principal_grants: ['model_id', 'id', 'principal_id'],
  promo_channels: ['model_id', 'id'],
  provenance: [
    'model_id',
    'id',
    'relation',
    'child_item_id',
    'child_version_id',
    'parent_item_id',
    'parent_version_id',
  ],
  rendition_artifacts: ['id', 'generation_id', 'name', 'output_sha256', 'storage_key'],
  rendition_generations: [
    'id',
    'kind',
    'recipe_digest',
    'meta_stripped',
    'input_kind',
    'input_sha256',
  ],
  review_cases: ['model_id', 'id', 'kind', 'dedup_key'],
  source_objects: [
    'model_id',
    'id',
    'source_id',
    'resource_id',
    'upload_id',
    'archive_revision_id',
    'archive_entry_no',
  ],
  source_paths: ['model_id', 'id', 'source_object_id', 'path_raw', 'name'],
  source_revisions: [
    'model_id',
    'id',
    'source_object_id',
    'sequence_no',
    'md5',
    'remote_sha256',
    'content_hash',
    'remote_rev',
    'byte_size',
    'remote_created_at',
    'remote_modified_at',
    'remote_shot_at',
    'media_type',
    'crc32',
    'detected_at',
    'scan_work_id',
    'previous_id',
  ],
  sources: ['model_id', 'id', 'kind'],
  storage_operations: ['id', 'kind', 'blob_sha256', 'from_key', 'to_key'],
  surfaces: ['model_id', 'id', 'account_id', 'kind'],
  tags: ['id', 'model_id'],
  web_uploads: ['model_id', 'id', 'upload_id', 'principal_id', 'size_expected'],
  work_operations: [
    'model_id',
    'kind',
    'work_key',
    'account_id',
    'dataset',
    'scope',
    'window_from',
    'window_to',
    'draft_id',
    'source_revision_id',
    'asset_version_id',
    'manifest_id',
    'receipt_id',
    'generation_id',
  ],
}
/** Columns written once, NULL → value (`set_once`). */
const SET_ONCE_COLUMNS: Record<string, string[]> = {
  rendition_generations: ['master_sha256', 'bound_at'],
  source_revisions: [
    'source_sha256',
    'verified_at',
    'verified_route',
    'frozen_by_work_id',
    'frozen_path',
  ],
}
/**
 * FKs into a table with shared rows (`model_id IS NULL`) cannot be composite: a trigger
 * admits a shared row or one of the same model (schema §9.2). FK name → guarding trigger.
 */
const SCOPE_TRIGGER_FKS: Record<string, string> = {
  item_tags_tag_id_fkey: 'item_tags_tag_scope',
}

interface ForeignKey {
  name: string
  source: string
  target: string
  sourceColumns: string[]
  targetColumns: string[]
  deferrable: boolean
}

let db: TestDatabase
let pool: pg.Pool
let tables: Map<string, { hasModel: boolean; modelNotNull: boolean; primaryKey: string[] }>
let foreignKeys: ForeignKey[]

beforeAll(async () => {
  db = await createTestDatabase()
  pool = new pg.Pool({ connectionString: db.url('app') })
  const { rows: tableRows } = await pool.query<{
    name: string
    model_not_null: boolean | null
    primary_key: string[] | null
  }>(`
    SELECT c.relname AS name,
           m.attnotnull AS model_not_null,
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM pg_constraint p
              CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = p.conrelid AND a.attnum = k.attnum
             WHERE p.conrelid = c.oid AND p.contype = 'p') AS primary_key
      FROM pg_class c
      LEFT JOIN pg_attribute m ON m.attrelid = c.oid AND m.attname = 'model_id' AND NOT m.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`)
  tables = new Map(
    tableRows.map((row) => [
      row.name,
      {
        hasModel: row.model_not_null !== null,
        modelNotNull: row.model_not_null === true,
        primaryKey: row.primary_key ?? [],
      },
    ]),
  )
  const { rows: fkRows } = await pool.query<ForeignKey>(`
    SELECT con.conname AS name,
           src.relname AS source,
           tgt.relname AS target,
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS "sourceColumns",
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS "targetColumns",
           con.condeferrable AS deferrable
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
     WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace
     ORDER BY con.conname`)
  foreignKeys = fkRows
})

afterAll(() => pool?.end())

/** FKs that must carry the model: the target holds model rows. */
function needsModel(fk: ForeignKey): boolean {
  const source = tables.get(fk.source)
  const target = tables.get(fk.target)
  if (!source || !target || fk.target === 'models' || !target.hasModel) return false
  if (fk.name in SCOPE_TRIGGER_FKS) return false
  return target.modelNotNull || source.modelNotNull
}

function compositeFks(): ForeignKey[] {
  return foreignKeys.filter(
    (fk) => needsModel(fk) && fk.sourceColumns.length > 1 && fk.sourceColumns.includes('model_id'),
  )
}

/**
 * Overriding the columns of one FK can break another FK of the same row that shares a
 * column (a pinned version and the file of a membership). Its target gets a twin in the
 * row's model with the same key, so only the FK under test can fail.
 */
async function satisfyOverlapping(
  client: pg.PoolClient,
  fk: ForeignKey,
  row: Record<string, unknown>,
  modelId: string,
): Promise<void> {
  const overridden = fk.sourceColumns.filter((column) => column !== 'model_id')
  for (const other of compositeFks()) {
    if (other.name === fk.name || other.source !== fk.source) continue
    if (!other.sourceColumns.some((column) => overridden.includes(column))) continue
    if (other.sourceColumns.some((column) => row[column] === null || row[column] === undefined)) {
      continue
    }
    const twin = await factory(other.target)(client, modelId)
    other.sourceColumns.forEach((column, i) => {
      if (column !== 'model_id') twin[other.targetColumns[i] ?? ''] = row[column]
    })
    await insert(client, other.target, twin)
  }
}

describe('model isolation in the catalog', () => {
  it('every table is classified, and every domain table has model_id first in its key', () => {
    for (const [name, table] of tables) {
      if (GLOBAL_TABLES.includes(name)) {
        expect(table.hasModel, `${name} is global but has model_id`).toBe(false)
      } else if (OPTIONAL_MODEL_TABLES.includes(name)) {
        expect(table.hasModel && !table.modelNotNull, `${name}: model_id must be nullable`).toBe(
          true,
        )
      } else {
        expect(table.modelNotNull, `${name}: model_id NOT NULL or classify the table`).toBe(true)
        expect(table.primaryKey[0], `${name}: primary key must start with model_id`).toBe(
          'model_id',
        )
      }
    }
    for (const name of [...GLOBAL_TABLES, ...OPTIONAL_MODEL_TABLES]) {
      expect(tables.has(name), `${name} is listed but missing`).toBe(true)
    }
  })

  it('every FK between model tables is composite with model_id on both sides', () => {
    for (const fk of foreignKeys) {
      const source = tables.get(fk.source)
      const target = tables.get(fk.target)
      if (target?.modelNotNull) {
        expect(source?.hasModel, `${fk.name}: a table without model_id points at model rows`).toBe(
          true,
        )
      }
      if (!needsModel(fk)) continue
      const at = fk.sourceColumns.indexOf('model_id')
      expect(at, `${fk.name} must include model_id`).toBeGreaterThanOrEqual(0)
      expect(fk.targetColumns[at], `${fk.name}: model_id must meet model_id`).toBe('model_id')
      expect(fk.sourceColumns.length, `${fk.name} must be composite`).toBeGreaterThan(1)
    }
  })

  it('an FK into shared rows is guarded by its scope trigger', async () => {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY ($1)',
      [Object.values(SCOPE_TRIGGER_FKS)],
    )
    expect(rows.map((row) => row.name).sort()).toEqual(Object.values(SCOPE_TRIGGER_FKS).sort())
    for (const name of Object.keys(SCOPE_TRIGGER_FKS)) {
      expect(
        foreignKeys.some((fk) => fk.name === name),
        `${name} is listed but missing`,
      ).toBe(true)
    }
  })

  it('a reference to a row of another model fails with 23503 for every composite FK', async () => {
    const cases = compositeFks()
    expect(cases.length).toBeGreaterThan(0)
    for (const fk of cases) {
      const makeSource = factory(fk.source)
      const makeTarget = factory(fk.target)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await journalContext(client)
        const [modelA, modelB] = await Promise.all([newModel(client), newModel(client)])
        const foreign = await insert(
          client,
          fk.target,
          await makeTarget(client, modelB, [], fk.source),
        )
        const row = await makeSource(client, modelA, fk.sourceColumns)
        fk.sourceColumns.forEach((column, i) => {
          if (column !== 'model_id') row[column] = foreign[fk.targetColumns[i] ?? '']
        })
        await satisfyOverlapping(client, fk, row, modelA)
        await client.query('SAVEPOINT probe')
        // A deferred FK is checked here, not at a commit that never comes.
        if (fk.deferrable) await client.query(`SET CONSTRAINTS "${fk.name}" IMMEDIATE`)
        const error = await insert(client, fk.source, row).then(
          () => null,
          (e: pg.DatabaseError) => e,
        )
        expect(error?.code, `${fk.name} accepted a row of another model`).toBe('23503')
        expect(error?.constraint, `${fk.name}: ${error?.message}`).toBe(fk.name)
        await client.query('ROLLBACK TO SAVEPOINT probe')
        // The same row inside its own model is valid: the factory is not the cause.
        await insert(client, fk.source, await makeSource(client, modelA, fk.sourceColumns))
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }
  })
})

describe('journal and guards in the catalog', () => {
  it('every mutable table has the journal trigger on INSERT, UPDATE and DELETE', async () => {
    const { rows } = await pool.query<{ table: string; type: number }>(`
      SELECT c.relname AS table, t.tgtype AS type
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE p.proname = 'log_row_change' AND NOT t.tgisinternal`)
    const journaled = new Map(rows.map((row) => [row.table, row.type]))
    for (const name of tables.keys()) {
      if (NO_JOURNAL.includes(name) || APPEND_ONLY.includes(name)) {
        expect(journaled.has(name), `${name} must not carry the journal trigger`).toBe(false)
        continue
      }
      // ROW (1) | INSERT (4) | DELETE (8) | UPDATE (16), not BEFORE (2).
      expect(journaled.get(name), `${name} has no journal trigger`).toBeDefined()
      expect((journaled.get(name) ?? 0) & 31, `${name}: AFTER ROW I/U/D`).toBe(29)
    }
  })

  it('lists every guard: append-only tables, fixed and set-once columns', async () => {
    const { rows } = await pool.query<{
      table: string
      fn: string
      def: string
      conditional: boolean
    }>(`
      SELECT c.relname AS table, p.proname AS fn, pg_get_triggerdef(t.oid) AS def,
             t.tgqual IS NOT NULL AS conditional
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE p.proname IN ('forbid_update_delete', 'forbid_change', 'set_once')
         AND NOT t.tgisinternal`)
    const appendOnly = rows
      .filter((row) => row.fn === 'forbid_update_delete' && !row.conditional)
      .map((row) => row.table)
    expect(appendOnly.sort()).toEqual([...APPEND_ONLY].sort())
    const columnsOf = (fn: string) =>
      Object.fromEntries(
        rows
          .filter((row) => row.fn === fn)
          .map((row) => [
            row.table,
            [
              ...(new RegExp(`${fn}\\((.*)\\)$`).exec(row.def)?.[1] ?? '').matchAll(/'([^']+)'/g),
            ].map((m) => m[1]),
          ]),
      )
    expect(columnsOf('forbid_change')).toEqual(FIXED_COLUMNS)
    expect(columnsOf('set_once')).toEqual(SET_ONCE_COLUMNS)
  })

  it('the app role cannot UPDATE or DELETE append-only tables, nor write the ledger', async () => {
    const { rows } = await pool.query<{ table: string; privilege: string; granted: boolean }>(
      `SELECT t AS table, p AS privilege, has_table_privilege('contentops_app', t, p) AS granted
         FROM unnest($1::text[]) AS t, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p`,
      [[...APPEND_ONLY, ...NO_DELETE, 'schema_migrations']],
    )
    for (const row of rows) {
      const allowed =
        row.table === 'schema_migrations'
          ? false
          : NO_DELETE.includes(row.table)
            ? row.privilege !== 'DELETE'
            : row.privilege === 'INSERT'
      expect(row.granted, `${row.privilege} on ${row.table}`).toBe(allowed)
    }
    const { rows: mutable } = await pool.query<{ table: string }>(
      `SELECT c.relname AS table FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND NOT (c.relname = ANY ($1))
          AND NOT has_table_privilege('contentops_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE')`,
      [[...APPEND_ONLY, 'schema_migrations']],
    )
    expect(mutable, 'app role lacks DML').toEqual([])
  })

  it('guards fire for the owner role too', async () => {
    const owner = new pg.Client({ connectionString: db.url('migrate') })
    await owner.connect()
    try {
      await owner.query('BEGIN')
      await journalContext(owner)
      const { rows } = await owner.query(
        "INSERT INTO models (code, title, title_genitive) VALUES ('guard', 'G', 'G') RETURNING id",
      )
      await owner.query(
        "INSERT INTO id_counters (model_id, type, next_number) VALUES ($1, 'PPV', 1)",
        [rows[0].id],
      )
      await owner.query('SAVEPOINT s')
      await expect(owner.query("UPDATE id_counters SET type = 'SET'")).rejects.toMatchObject({
        code: dbErrorCodes.immutableColumn,
      })
      await owner.query('ROLLBACK TO SAVEPOINT s')
      await expect(owner.query('DELETE FROM action_log')).rejects.toMatchObject({
        code: dbErrorCodes.immutableRow,
      })
      await owner.query('ROLLBACK TO SAVEPOINT s')
      const work = await owner.query(
        `INSERT INTO work_operations (model_id, kind, work_key, state, finished_at)
         VALUES ($1, 'scan', 'scan:x', 'succeeded', now()) RETURNING id`,
        [rows[0].id],
      )
      await expect(
        owner.query("UPDATE work_operations SET error_text = 'late' WHERE id = $1", [
          work.rows[0].id,
        ]),
      ).rejects.toMatchObject({ code: dbErrorCodes.immutableRow })
    } finally {
      await owner.query('ROLLBACK')
      await owner.end()
    }
  })
})
