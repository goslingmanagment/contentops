import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDb,
  createPool,
  type Db,
  type JournalContext,
  logAction,
  SYSTEM_ACTOR,
  setJournalItem,
  withActorTx,
} from './client.ts'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'
import { dbErrorCodes } from './values.ts'

let database: TestDatabase
let pool: pg.Pool
let db: Db

beforeAll(async () => {
  database = await createTestDatabase()
  pool = createPool(database.url('app'), { max: 4 })
  db = createDb(pool)
})
afterAll(() => pool?.end())

function context(overrides: Partial<JournalContext> = {}): JournalContext {
  return {
    actor: SYSTEM_ACTOR('test'),
    action: 'test.write',
    requestId: randomUUID(),
    ...overrides,
  }
}

async function logRows(requestId: string) {
  const { rows } = await pool.query(
    `SELECT actor_type, actor_id, actor_label, action, entry_kind, item_id, subject_kind,
            subject_id, subject_label, before, after, result, model_id
       FROM action_log WHERE request_id = $1 ORDER BY id`,
    [requestId],
  )
  return rows
}

async function newModel(ctx = context()): Promise<{ id: string; code: string }> {
  const code = `m${randomUUID().slice(0, 8)}`
  const id = await withActorTx(db, ctx, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO models (code, title, title_genitive) VALUES (${code}, 'Лора', 'Лоры') RETURNING id`,
    )
    const [row] = rows
    if (!row) throw new Error('no model row')
    return row.id
  })
  return { id, code }
}

describe('journal trigger', () => {
  it('rejects a write without the journal context', async () => {
    await expect(
      pool.query("INSERT INTO models (code, title, title_genitive) VALUES ('nobody', 'N', 'N')"),
    ).rejects.toMatchObject({ code: dbErrorCodes.journalContextMissing })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // A person without a principal id and a context without a request id are both rejected.
      await client.query(`SELECT set_config('app.actor_type', 'human', true),
        set_config('app.actor_label', 'Диана', true), set_config('app.action', 'x', true),
        set_config('app.request_id', 'r', true)`)
      await expect(
        client.query("INSERT INTO models (code, title, title_genitive) VALUES ('anon', 'A', 'A')"),
      ).rejects.toMatchObject({ code: dbErrorCodes.journalContextMissing })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    const { rows } = await pool.query("SELECT 1 FROM models WHERE code IN ('nobody', 'anon')")
    expect(rows).toEqual([])
  })

  it('INSERT and DELETE log the whole row, UPDATE only the changed keys and the row key', async () => {
    const ctx = context({ action: 'settings.models.create' })
    const model = await newModel(ctx)
    const [inserted] = await logRows(ctx.requestId)
    expect(inserted).toMatchObject({
      actor_type: 'system',
      actor_id: null,
      actor_label: 'test',
      action: 'settings.models.create',
      entry_kind: 'change',
      subject_kind: 'models',
      subject_id: model.id,
      subject_label: model.code,
      model_id: model.id,
      before: null,
      result: 'ok',
    })
    expect(inserted.after).toMatchObject({ id: model.id, code: model.code, title: 'Лора' })

    const update = context({ action: 'settings.models.rename' })
    await withActorTx(db, update, async (tx) => {
      await tx.execute(
        sql`UPDATE models SET title = 'Лора Ви', row_version = row_version + 1 WHERE id = ${model.id}`,
      )
      // A technical mark alone is not a change.
      await tx.execute(sql`UPDATE models SET row_version = row_version + 1 WHERE id = ${model.id}`)
    })
    const updated = await logRows(update.requestId)
    expect(updated).toHaveLength(1)
    expect(updated[0].before).toEqual({ id: model.id, title: 'Лора' })
    expect(updated[0].after).toEqual({ id: model.id, title: 'Лора Ви' })

    const remove = context({ action: 'settings.promo.remove' })
    await withActorTx(db, remove, async (tx) => {
      await tx.execute(
        sql`INSERT INTO promo_channels (model_id, code, title) VALUES (${model.id}, 'instagram', 'Instagram')`,
      )
      await tx.execute(sql`DELETE FROM promo_channels WHERE model_id = ${model.id}`)
    })
    const [, deleted] = await logRows(remove.requestId)
    expect(deleted.after).toBeNull()
    expect(deleted.before).toMatchObject({ model_id: model.id, code: 'instagram' })
  })

  it('carries the person, the item and the typed action row of a command', async () => {
    const person = await pool.query(
      `INSERT INTO principals (kind, login, display_name, gender, role)
       VALUES ('human', $1, 'Диана', 'f', 'manager') RETURNING id`,
      [`diana-${randomUUID().slice(0, 6)}`],
    )
    const model = await newModel()
    const itemId = randomUUID()
    const ctx = context({
      actor: { type: 'human', id: person.rows[0].id, label: 'Диана' },
      action: 'settings.channel.add',
    })
    await withActorTx(db, ctx, async (tx) => {
      await setJournalItem(tx, itemId)
      await tx.execute(
        sql`INSERT INTO promo_channels (model_id, code, title) VALUES (${model.id}, 'reddit', 'Reddit')`,
      )
      await logAction(tx, {
        modelId: model.id,
        subjectKind: 'promo_channels',
        subjectLabel: 'reddit',
        after: { title: 'Reddit', list: [1, 2] },
      })
    })
    const [change, action] = await logRows(ctx.requestId)
    expect(change).toMatchObject({ entry_kind: 'change', actor_type: 'human', item_id: itemId })
    expect(change.actor_id).toBe(person.rows[0].id)
    expect(action).toMatchObject({
      entry_kind: 'action',
      action: 'settings.channel.add',
      actor_label: 'Диана',
      item_id: itemId,
      after: { title: 'Reddit', list: [1, 2] },
    })
  })

  it('a failed transaction leaves no success record; the error is written after the rollback', async () => {
    const ctx = context({ action: 'settings.models.create' })
    await expect(
      withActorTx(db, ctx, async (tx) => {
        await tx.execute(
          sql`INSERT INTO models (code, title, title_genitive) VALUES ('rolled-back', 'R', 'R')`,
        )
        await logAction(tx, { modelId: null, subjectKind: 'models', subjectLabel: 'rolled-back' })
        throw new Error('command failed')
      }),
    ).rejects.toThrow('command failed')
    expect(await logRows(ctx.requestId)).toEqual([])

    await withActorTx(db, ctx, (tx) =>
      logAction(tx, {
        modelId: null,
        subjectKind: 'models',
        subjectLabel: 'rolled-back',
        result: 'error',
      }),
    )
    const rows = await logRows(ctx.requestId)
    expect(rows.map((row) => [row.entry_kind, row.result])).toEqual([['action', 'error']])
  })
})

describe('secrets', () => {
  it('the trigger never logs password or token hashes', async () => {
    // A throwaway table with secret columns under the same trigger.
    const owner = new pg.Client({ connectionString: database.url('migrate') })
    await owner.connect()
    await owner.query(`CREATE TABLE secret_probe (id uuid PRIMARY KEY DEFAULT uuidv7(), login text,
      password_hash text, token_hash bytea);
      CREATE TRIGGER secret_probe_journal AFTER INSERT OR UPDATE OR DELETE ON secret_probe
      FOR EACH ROW EXECUTE FUNCTION log_row_change('id')`)
    await owner.end()

    const ctx = context()
    await withActorTx(db, ctx, async (tx) => {
      await tx.execute(sql`INSERT INTO secret_probe (login, password_hash, token_hash)
        VALUES ('x', '$argon2id$secret', '\\x00ff')`)
      await tx.execute(sql`UPDATE secret_probe SET password_hash = 'changed', login = 'y'`)
      // Only a secret changed: nothing to log.
      await tx.execute(sql`UPDATE secret_probe SET password_hash = 'again'`)
    })
    const rows = await logRows(ctx.requestId)
    expect(rows).toHaveLength(2)
    const text = JSON.stringify(rows)
    expect(text).not.toContain('password_hash')
    expect(text).not.toContain('token_hash')
    expect(text).not.toContain('argon2')
  })

  it('action_log and idempotency_keys refuse documents with secrets', async () => {
    const person = await pool.query(
      `INSERT INTO principals (kind, login, display_name, role)
       VALUES ('agent', $1, 'агент', 'manager') RETURNING id`,
      [`agent-${randomUUID().slice(0, 6)}`],
    )
    const write = (response: unknown) =>
      pool.query(
        `INSERT INTO idempotency_keys (principal_id, operation, key, request_digest, state, response)
         VALUES ($1, 'tokens.create', $2, sha256('x'), 'committed', $3)`,
        [person.rows[0].id, randomUUID(), JSON.stringify(response)],
      )
    await expect(
      write({ status: 201, body: { token: 'co_live_secret', token_prefix: 'co_live' } }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'idempotency_keys_no_secrets' })
    await expect(
      write({ status: 200, headers: { 'Set-Cookie': 'session=abc' } }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(write({ status: 200, body: { token_prefix: 'co_live' } })).resolves.toBeDefined()

    await expect(
      withActorTx(db, context(), (tx) =>
        logAction(tx, {
          modelId: null,
          subjectKind: 'api_tokens',
          subjectLabel: 'intake',
          after: { name: 'intake', nested: [{ Authorization: 'Bearer x' }] },
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) })
  })
})

describe('append-only journal', () => {
  it('the app role cannot UPDATE or DELETE action_log', async () => {
    await newModel()
    await expect(pool.query("UPDATE action_log SET action = 'rewritten'")).rejects.toMatchObject({
      code: '42501',
    })
    await expect(pool.query('DELETE FROM action_log')).rejects.toMatchObject({ code: '42501' })
  })
})
