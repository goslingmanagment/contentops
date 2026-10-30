import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'
import { dbErrorCodes } from './values.ts'

/**
 * Structural rules over pg_catalog (schema §1 p. 1, §9.2, §9.4). They hold for every later
 * migration: a new table must be classified here, a new composite FK needs a row factory.
 */

/** Tables without `model_id`: no content of a model in them. */
const GLOBAL_TABLES = ['api_tokens', 'models', 'principals', 'schema_migrations', 'sessions']
/** Tables where `model_id` may be empty (system-wide rows); their key is `id`. */
const OPTIONAL_MODEL_TABLES = [
  'action_log',
  'idempotency_keys',
  'policy_settings',
  'work_operations',
]
/** Mutable tables without the journal trigger: their journal is typed events (schema §9.3). */
const NO_JOURNAL = [
  'api_tokens',
  'idempotency_keys',
  'principals',
  'schema_migrations',
  'sessions',
  'work_operations',
]
/** Append-only tables: `forbid_update_delete()` and no UPDATE/DELETE for the app role. */
const APPEND_ONLY = ['action_log']
/** Columns that never change (`forbid_change`). */
const FIXED_COLUMNS: Record<string, string[]> = {
  accounts: ['model_id', 'id'],
  id_counters: ['model_id', 'type'],
  policy_settings: ['model_id', 'account_id', 'item_type', 'key'],
  principal_grants: ['model_id', 'id', 'principal_id'],
  promo_channels: ['model_id', 'id'],
  surfaces: ['model_id', 'id', 'account_id', 'kind'],
  work_operations: [
    'model_id',
    'kind',
    'work_key',
    'account_id',
    'dataset',
    'scope',
    'window_from',
    'window_to',
  ],
}

type Row = Record<string, unknown>
type Factory = (client: pg.PoolClient, modelId: string) => Promise<Row>

async function accountRow(_client: pg.PoolClient, modelId: string): Promise<Row> {
  const code = `acc-${randomUUID().slice(0, 8)}`
  return { model_id: modelId, code, platform: 'fansly', title: code, handle: code, position: 1 }
}

async function workRow(_client: pg.PoolClient, modelId: string): Promise<Row> {
  return { model_id: modelId, kind: 'scan', work_key: `scan:${randomUUID()}` }
}

/** Column values of a valid row of the table in a model; dependencies are inserted. */
const FACTORIES: Record<string, Factory> = {
  accounts: accountRow,
  work_operations: workRow,
  surfaces: async (client, modelId) => {
    const account = await insert(client, 'accounts', await accountRow(client, modelId))
    return { model_id: modelId, account_id: account.id, kind: 'wall' }
  },
  id_counters: async (client, modelId) => {
    const work = await insert(client, 'work_operations', await workRow(client, modelId))
    return { model_id: modelId, type: 'PPV', next_number: 1, legacy_reserved_work_id: work.id }
  },
  policy_settings: async (client, modelId) => {
    const account = await insert(client, 'accounts', await accountRow(client, modelId))
    return { model_id: modelId, account_id: account.id, key: 'hub.receive', value: true }
  },
}

function factory(table: string): Factory {
  const make = FACTORIES[table]
  if (!make) throw new Error(`add a row factory for ${table}`)
  return make
}

async function insert(client: pg.PoolClient, table: string, row: Row): Promise<Row> {
  const columns = Object.keys(row)
  const values = columns.map((column) => {
    const value = row[column]
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : value
  })
  const { rows } = await client.query(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING to_jsonb(${table}.*) AS row`,
    values,
  )
  return rows[0].row
}

interface ForeignKey {
  name: string
  source: string
  target: string
  sourceColumns: string[]
  targetColumns: string[]
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
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS "targetColumns"
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
  return target.modelNotNull || source.modelNotNull
}

function compositeFks(): ForeignKey[] {
  return foreignKeys.filter(
    (fk) => needsModel(fk) && fk.sourceColumns.length > 1 && fk.sourceColumns.includes('model_id'),
  )
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
        const foreign = await insert(client, fk.target, await makeTarget(client, modelB))
        const row = await makeSource(client, modelA)
        fk.sourceColumns.forEach((column, i) => {
          if (column !== 'model_id') row[column] = foreign[fk.targetColumns[i] ?? '']
        })
        await client.query('SAVEPOINT probe')
        const error = await insert(client, fk.source, row).then(
          () => null,
          (e: pg.DatabaseError) => e,
        )
        expect(error?.code, `${fk.name} accepted a row of another model`).toBe('23503')
        expect(error?.constraint).toBe(fk.name)
        await client.query('ROLLBACK TO SAVEPOINT probe')
        // The same row inside its own model is valid: the factory is not the cause.
        await insert(client, fk.source, await makeSource(client, modelA))
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

  it('lists every guard: append-only tables and fixed columns', async () => {
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
       WHERE p.proname IN ('forbid_update_delete', 'forbid_change') AND NOT t.tgisinternal`)
    const appendOnly = rows
      .filter((row) => row.fn === 'forbid_update_delete' && !row.conditional)
      .map((row) => row.table)
    expect(appendOnly.sort()).toEqual([...APPEND_ONLY].sort())
    const fixed = Object.fromEntries(
      rows
        .filter((row) => row.fn === 'forbid_change')
        .map((row) => [
          row.table,
          [...(/forbid_change\((.*)\)$/.exec(row.def)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
            (m) => m[1],
          ),
        ]),
    )
    expect(fixed).toEqual(FIXED_COLUMNS)
  })

  it('the app role cannot UPDATE or DELETE append-only tables, nor write the ledger', async () => {
    const { rows } = await pool.query<{ table: string; privilege: string; granted: boolean }>(
      `SELECT t AS table, p AS privilege, has_table_privilege('contentops_app', t, p) AS granted
         FROM unnest($1::text[]) AS t, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p`,
      [[...APPEND_ONLY, 'schema_migrations']],
    )
    for (const row of rows) {
      const allowed = row.privilege === 'INSERT' && row.table !== 'schema_migrations'
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

async function journalContext(client: pg.ClientBase) {
  await client.query(`SELECT set_config('app.actor_type', 'system', true),
    set_config('app.actor_label', 'test', true), set_config('app.action', 'test', true),
    set_config('app.request_id', 'test', true)`)
}

async function newModel(client: pg.ClientBase): Promise<string> {
  const code = `m${randomUUID().slice(0, 8)}`
  const { rows } = await client.query(
    'INSERT INTO models (code, title, title_genitive) VALUES ($1, $1, $1) RETURNING id',
    [code],
  )
  return rows[0].id
}
