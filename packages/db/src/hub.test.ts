import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'
import { factory, insert, journalContext, make, newModel, type Row } from './testing/rows.ts'
import { dbErrorCodes } from './values.ts'

/**
 * The Hub mirror (schema §3.6, §9.4, §9.6): the observation log is append-only and counts the
 * changes of a row — A→B→A is three observations, never deduplicated by hash; the attachment
 * slots, Hub's link states and the match projection hold their rules; the poll boundary is
 * journaled; evidence points at an observation — as the app role, on real PostgreSQL.
 */

let db: TestDatabase
let pool: pg.Pool

beforeAll(async () => {
  db = await createTestDatabase()
  pool = new pg.Pool({ connectionString: db.url('app'), max: 4 })
})
afterAll(() => pool?.end())

async function inTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await journalContext(client)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** For rows of factories that only hold inside a transaction (a sealed receipt of one row). */
async function rolledBack(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await journalContext(client)
    await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}

function fails(promise: Promise<unknown>, code: string, constraint?: string) {
  return expect(promise).rejects.toMatchObject(constraint ? { code, constraint } : { code })
}

/** An observation of `key` after `previous` (or the first one). */
function observation(base: Row, key: string, hash: Buffer, previous: Row | null): Row {
  return {
    ...base,
    external_key: key,
    semantic_hash: hash,
    sequence_no: previous ? Number(previous.sequence_no) + 1 : 1,
    previous_id: previous ? previous.id : null,
  }
}

describe('observation log', () => {
  it('A→B→A is three observations of one row, chained', async () => {
    const [a, b] = [randomBytes(32), randomBytes(32)]
    const chain = await inTx(async (c) => {
      const base = await factory('hub_observations')(c, await newModel(c))
      const first = await insert(c, 'hub_observations', observation(base, 'p1', a, null))
      const second = await insert(c, 'hub_observations', observation(base, 'p1', b, first))
      const third = await insert(c, 'hub_observations', observation(base, 'p1', a, second))
      return [first, second, third]
    })
    expect(chain.map((row) => row.sequence_no)).toEqual([1, 2, 3])
    expect(chain[2]?.semantic_hash).toEqual(chain[0]?.semantic_hash)
    expect(chain[2]?.previous_id).toBe(chain[1]?.id)
  })

  it('a sequence number is taken once; the chain starts at 1 and only there', async () => {
    await inTx(async (c) => {
      const base = await factory('hub_observations')(c, await newModel(c))
      const first = await insert(
        c,
        'hub_observations',
        observation(base, 'p2', randomBytes(32), null),
      )
      await c.query('SAVEPOINT s')
      await fails(
        insert(c, 'hub_observations', observation(base, 'p2', randomBytes(32), null)),
        '23505',
        'hub_observations_sequence',
      )
      await c.query('ROLLBACK TO SAVEPOINT s')
      await fails(
        insert(c, 'hub_observations', {
          ...observation(base, 'p2', randomBytes(32), first),
          previous_id: null,
        }),
        '23514',
        'hub_observations_previous',
      )
      await c.query('ROLLBACK TO SAVEPOINT s')
      await fails(
        insert(c, 'hub_observations', {
          ...observation(base, 'p3', randomBytes(32), null),
          previous_id: first.id,
        }),
        '23514',
        'hub_observations_previous',
      )
    })
  })

  it('an observation never changes or goes away, also for the owner role', async () => {
    const row = await inTx(async (c) => make(c, 'hub_observations', await newModel(c)))
    await fails(
      pool.query('UPDATE hub_observations SET payload = $2 WHERE id = $1', [row.id, '{}']),
      '42501',
    )
    await fails(pool.query('DELETE FROM hub_observations WHERE id = $1', [row.id]), '42501')
    const owner = new pg.Client({ connectionString: db.url('migrate') })
    await owner.connect()
    try {
      await expect(
        owner.query('DELETE FROM hub_observations WHERE id = $1', [row.id]),
      ).rejects.toMatchObject({ code: dbErrorCodes.immutableRow })
    } finally {
      await owner.end()
    }
  })

  it('takes only the datasets it logs', async () => {
    await inTx(async (c) => {
      const base = await factory('hub_observations')(c, await newModel(c))
      await fails(
        insert(c, 'hub_observations', { ...base, dataset: 'sync_streams' }),
        '23514',
        'hub_observations_dataset_check',
      )
    })
  })
})

describe('current rows', () => {
  it('one slot of a post holds one attachment row, NULL member included', async () => {
    await inTx(async (c) => {
      const row = await factory('hub_post_attachments')(c, await newModel(c))
      await insert(c, 'hub_post_attachments', { ...row, member_index: null })
      await c.query('SAVEPOINT s')
      await fails(
        insert(c, 'hub_post_attachments', { ...row, hub_key: 'other', member_index: null }),
        '23505',
        'hub_post_attachments_slot',
      )
      await c.query('ROLLBACK TO SAVEPOINT s')
      // The preview of the same offer is a slot of its own.
      await insert(c, 'hub_post_attachments', {
        ...row,
        hub_key: 'preview',
        member_index: null,
        role: 'offer_preview',
      })
    })
  })

  it('knows Hub’s seven link states and three roles, nothing else', async () => {
    await inTx(async (c) => {
      const row = await factory('hub_post_attachments')(c, await newModel(c))
      await c.query('SAVEPOINT s')
      await fails(
        insert(c, 'hub_post_attachments', { ...row, link_state: 'gone' }),
        '23514',
        'hub_post_attachments_link_state_check',
      )
      await c.query('ROLLBACK TO SAVEPOINT s')
      await fails(
        insert(c, 'hub_post_attachments', { ...row, role: 'poll' }),
        '23514',
        'hub_post_attachments_role_check',
      )
    })
  })

  it('a match names its version; an issued file needs the version it was issued from', async () => {
    await rolledBack(async (c) => {
      const modelId = await newModel(c)
      const row = await factory('hub_post_attachments')(c, modelId, ['receipt_entry_id'])
      await c.query('SAVEPOINT s')
      await fails(
        insert(c, 'hub_post_attachments', { ...row, match_strength: 'none' }),
        '23514',
        'hub_post_attachments_matched',
      )
      await c.query('ROLLBACK TO SAVEPOINT s')
      await fails(
        insert(c, 'hub_post_attachments', {
          ...row,
          matched_asset_id: null,
          matched_version_id: null,
          match_strength: 'none',
          matched_at: null,
        }),
        '23514',
        'hub_post_attachments_receipt_version',
      )
      await c.query('ROLLBACK TO SAVEPOINT s')
      // A file issued from another version of the model is not this match.
      const other = await make(c, 'asset_versions', modelId)
      await fails(
        insert(c, 'hub_post_attachments', {
          ...row,
          matched_asset_id: other.asset_id,
          matched_version_id: other.id,
        }),
        '23503',
      )
      await c.query('ROLLBACK TO SAVEPOINT s')
      await insert(c, 'hub_post_attachments', row)
    })
  })

  it('the name of a platform file is kept without extension, in lower case', async () => {
    const row = await inTx(async (c) => {
      const media = await factory('hub_raw_media')(c, await newModel(c))
      return insert(c, 'hub_raw_media', { ...media, filename: 'PPV-073_V2_Lora-1.MP4' })
    })
    expect(row.filename_norm).toBe('ppv-073_v2_lora-1')
  })

  it('a page and a post ref are one current row', async () => {
    await inTx(async (c) => {
      const post = await make(c, 'hub_posts', await newModel(c))
      const { model_id, account_id, post_ref, current_observation_id } = post
      await fails(
        insert(c, 'hub_posts', { model_id, account_id, post_ref, current_observation_id }),
        '23505',
        'hub_posts_ref',
      )
    })
  })
})

describe('poll boundary', () => {
  it('is journaled: the inputs of a past verdict come back from the log', async () => {
    const state = await inTx(async (c) => {
      const row = await make(c, 'hub_sync_state', await newModel(c))
      await c.query(
        `UPDATE hub_sync_state SET last_success_at = now(), hub_succeeded_at = now() - interval '2 hours'
          WHERE id = $1`,
        [row.id],
      )
      return row
    })
    const { rows } = await pool.query<{ before: Row | null; after: Row }>(
      `SELECT before, after FROM action_log
        WHERE subject_kind = 'hub_sync_state' AND subject_id = $1 ORDER BY id`,
      [state.id],
    )
    expect(rows).toHaveLength(2)
    expect(Object.keys(rows[1]?.after ?? {}).sort()).toEqual(
      ['hub_succeeded_at', 'id', 'last_success_at', 'model_id'].sort(),
    )
  })

  it('an unavailable stream says why', async () => {
    await inTx(async (c) => {
      const row = await factory('hub_sync_state')(c, await newModel(c))
      await fails(
        insert(c, 'hub_sync_state', { ...row, available: false }),
        '23514',
        'hub_sync_state_available',
      )
    })
  })
})

describe('evidence', () => {
  it('Hub evidence points at an observation of its own model', async () => {
    await inTx(async (c) => {
      const modelId = await newModel(c)
      const row = await factory('placement_evidence')(c, modelId, ['hub_observation_id'])
      await c.query('SAVEPOINT s')
      const foreign = await make(c, 'hub_observations', await newModel(c))
      await fails(
        insert(c, 'placement_evidence', { ...row, hub_observation_id: foreign.id }),
        '23503',
      )
      await c.query('ROLLBACK TO SAVEPOINT s')
      await insert(c, 'placement_evidence', row)
    })
  })
})
