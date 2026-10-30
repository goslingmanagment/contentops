import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'
import { factory, insert, journalContext, make, newModel, type Row } from './testing/rows.ts'
import { dbErrorCodes } from './values.ts'

/**
 * Plan rows, releases and placements (schema §3.5, §3.6, §9.2, §9.4; SPEC §5, §7) as the app
 * role on real PostgreSQL: the slot in the model's timezone, the release on its own page, the
 * second person never on OnlyFans (a new row, a move, a new composition, a montage, and the race
 * of the flag with the plan), the evidence triple, one publication — one placement.
 */

let db: TestDatabase
let pool: pg.Pool

beforeAll(async () => {
  db = await createTestDatabase()
  pool = new pg.Pool({ connectionString: db.url('app'), max: 6 })
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

function fails(promise: Promise<unknown>, code: string, constraint?: string) {
  return expect(promise).rejects.toMatchObject(constraint ? { code, constraint } : { code })
}

interface Page {
  modelId: string
  accountId: string
  surfaces: Record<string, string>
}

/** A page with all five surfaces. */
async function page(
  client: pg.ClientBase,
  modelId: string,
  platform: 'fansly' | 'onlyfans',
): Promise<Page> {
  const account = await insert(client, 'accounts', {
    ...(await factory('accounts')(client, modelId)),
    platform,
  })
  const surfaces: Record<string, string> = {}
  for (const kind of ['wall', 'fyp', 'story', 'vault', 'mass_dm']) {
    const surface = await insert(client, 'surfaces', {
      model_id: modelId,
      account_id: account.id,
      kind,
    })
    surfaces[kind] = surface.id as string
  }
  return { modelId, accountId: account.id as string, surfaces }
}

async function ppv(client: pg.ClientBase, modelId: string, secondPerson: boolean | null) {
  const row = await factory('content_items')(client, modelId, [], 'ppv_releases')
  return insert(client, 'content_items', { ...row, has_second_person: secondPerson })
}

/** A sealed composition of one version: the manifest with its one entry. */
async function manifest(client: pg.ClientBase, modelId: string): Promise<string> {
  return (await make(client, 'asset_manifest_entries', modelId)).manifest_id as string
}

async function planRow(
  client: pg.ClientBase,
  on: Page,
  surface: string,
  extra: Row = {},
): Promise<Row> {
  return insert(client, 'posting_plan_rows', {
    model_id: on.modelId,
    account_id: on.accountId,
    surface_id: on.surfaces[surface],
    slot_date: '2026-09-22',
    slot_time: '20:00',
    manifest_id: await manifest(client, on.modelId),
    ...extra,
  })
}

async function agent(client: pg.ClientBase): Promise<string> {
  const row = await insert(client, 'principals', {
    kind: 'agent',
    login: `agent-${Math.random().toString(36).slice(2, 10)}`,
    display_name: 'агент',
    role: 'manager',
  })
  return row.id as string
}

/** A row marked «выложено» with the composition it was marked on. */
async function markedRow(
  client: pg.ClientBase,
  on: Page,
  surface: string,
  itemId: unknown,
  actor: string,
): Promise<Row> {
  const composition = await manifest(client, on.modelId)
  return planRow(client, on, surface, {
    item_id: itemId,
    manifest_id: composition,
    marked_at: new Date().toISOString(),
    marked_by: actor,
    mark_kind: 'posted',
    marked_manifest_id: composition,
  })
}

describe('the slot of a plan row (schema §9.2)', () => {
  it('is stored in the model timezone: 20:00 and «весь день» in Moscow; a wrong instant is refused', async () => {
    const modelId = await inTx((c) => newModel(c))
    const [evening, allDay] = await inTx(async (c) => {
      const on = await page(c, modelId, 'fansly')
      const item = await ppv(c, modelId, false)
      return [
        await planRow(c, on, 'wall', { item_id: item.id }),
        await planRow(c, on, 'vault', { item_id: item.id, slot_time: null }),
      ]
    })
    expect(evening?.slot_tz).toBe('Europe/Moscow')
    expect(new Date(evening?.slot_at as string).toISOString()).toBe('2026-09-22T17:00:00.000Z')
    expect(new Date(allDay?.slot_at as string).toISOString()).toBe('2026-09-21T21:00:00.000Z')
    // A move recomputes the instant; a disagreeing instant is refused.
    await inTx((c) =>
      c.query("UPDATE posting_plan_rows SET slot_date = '2026-09-23' WHERE id = $1", [evening?.id]),
    )
    const { rows } = await pool.query('SELECT slot_at FROM posting_plan_rows WHERE id = $1', [
      evening?.id,
    ])
    expect(rows[0].slot_at.toISOString()).toBe('2026-09-23T17:00:00.000Z')
    await fails(
      inTx((c) =>
        c.query("UPDATE posting_plan_rows SET slot_at = '2026-09-23T20:00:00Z' WHERE id = $1", [
          evening?.id,
        ]),
      ),
      dbErrorCodes.transitionRefused,
    )
  })
})

describe('rows of a PPV release (schema §3.5)', () => {
  it('stay on the release page, name their own surface and have one live row per surface', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { on, other, item, release } = await inTx(async (c) => {
      const on = await page(c, modelId, 'fansly')
      const other = await page(c, modelId, 'fansly')
      const item = await ppv(c, modelId, false)
      const release = await insert(c, 'ppv_releases', {
        model_id: modelId,
        account_id: on.accountId,
        item_id: item.id,
        release_date: '2026-09-24',
      })
      await planRow(c, on, 'wall', {
        item_id: item.id,
        release_id: release.id,
        release_surface_kind: 'wall',
      })
      return { on, other, item, release }
    })
    const cell = { item_id: item.id, release_id: release.id }
    await fails(
      inTx((c) => planRow(c, other, 'wall', { ...cell, release_surface_kind: 'wall' })),
      dbErrorCodes.transitionRefused,
    )
    await fails(
      inTx((c) => planRow(c, on, 'story', { ...cell, release_surface_kind: 'wall' })),
      dbErrorCodes.transitionRefused,
    )
    await fails(
      inTx((c) => planRow(c, on, 'wall', { ...cell, release_surface_kind: 'wall' })),
      '23505',
      'posting_plan_rows_release_surface',
    )
    // A row of a release ships its object; a release of another object is refused.
    const stranger = await inTx((c) => ppv(c, modelId, false))
    await fails(
      inTx((c) =>
        planRow(c, on, 'vault', {
          item_id: stranger.id,
          release_id: release.id,
          release_surface_kind: 'vault',
        }),
      ),
      '23503',
    )
    // Only a PPV is released.
    const custom = await inTx((c) => make(c, 'content_items', modelId))
    await fails(
      inTx((c) =>
        insert(c, 'ppv_releases', {
          model_id: modelId,
          account_id: on.accountId,
          item_id: custom.id,
          item_type: 'CUS',
          release_date: '2026-09-24',
        }),
      ),
      '23514',
    )
  })
})

describe('marks and cancellation of a row (SPEC §5)', () => {
  it('a marked row is not cancelled; a waiting row is not marked; a mark names its composition', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { row, waiting, actor } = await inTx(async (c) => {
      const on = await page(c, modelId, 'fansly')
      const item = await ppv(c, modelId, false)
      const actor = await agent(c)
      const row = await planRow(c, on, 'wall', { item_id: item.id })
      const waiting = await planRow(c, on, 'fyp', {
        manifest_id: null,
        expected_type: 'FYP',
        input_manifest_id: await manifest(c, modelId),
      })
      return { row, waiting, actor }
    })
    const mark = `UPDATE posting_plan_rows
                     SET marked_at = now(), marked_by = $2, mark_kind = 'posted',
                         marked_manifest_id = manifest_id WHERE id = $1`
    await inTx((c) => c.query(mark, [row.id, actor]))
    await fails(
      inTx((c) =>
        c.query('UPDATE posting_plan_rows SET cancelled_at = now() WHERE id = $1', [row.id]),
      ),
      '23514',
      'posting_plan_rows_marked_cancelled',
    )
    await fails(
      inTx((c) => c.query(mark, [waiting.id, actor])),
      '23514',
      'posting_plan_rows_mark',
    )
    // A mark without its composition is not a mark.
    await fails(
      inTx((c) =>
        c.query(`UPDATE posting_plan_rows SET marked_manifest_id = NULL WHERE id = $1`, [row.id]),
      ),
      '23514',
      'posting_plan_rows_mark',
    )
  })
})

describe('second person in frame never goes to OnlyFans (schema §9.2, §9.4)', () => {
  async function setup(flag: boolean | null) {
    const modelId = await inTx((c) => newModel(c))
    return inTx(async (c) => ({
      modelId,
      fansly: await page(c, modelId, 'fansly'),
      onlyfans: await page(c, modelId, 'onlyfans'),
      item: await ppv(c, modelId, flag),
    }))
  }

  it('a new row on OnlyFans is refused with the flag and without an answer; Fansly takes it', async () => {
    for (const flag of [true, null]) {
      const { fansly, onlyfans, item } = await setup(flag)
      await fails(
        inTx((c) => planRow(c, onlyfans, 'wall', { item_id: item.id })),
        dbErrorCodes.secondPersonOnOnlyFans,
      )
      await expect(
        inTx((c) => planRow(c, fansly, 'wall', { item_id: item.id })),
      ).resolves.toBeTruthy()
    }
    const unchecked = await setup(null)
    const error = await inTx((c) =>
      planRow(c, unchecked.onlyfans, 'vault', { item_id: unchecked.item.id }),
    ).catch((e: pg.DatabaseError) => e)
    expect(error).toMatchObject({ code: dbErrorCodes.secondPersonOnOnlyFans, detail: 'unchecked' })
  })

  it('a move to OnlyFans, a new composition and a ready montage on OnlyFans are refused', async () => {
    const { modelId, fansly, onlyfans, item } = await setup(true)
    const row = await inTx((c) => planRow(c, fansly, 'wall', { item_id: item.id }))
    await fails(
      inTx((c) =>
        c.query('UPDATE posting_plan_rows SET account_id = $2, surface_id = $3 WHERE id = $1', [
          row.id,
          onlyfans.accountId,
          onlyfans.surfaces.wall,
        ]),
      ),
      dbErrorCodes.secondPersonOnOnlyFans,
    )
    // Marked while the flag was off; after the flag the row stays history, «Заменить состав» is refused.
    const clean = await setup(false)
    const actor = await inTx((c) => agent(c))
    const marked = await inTx((c) => markedRow(c, clean.onlyfans, 'wall', clean.item.id, actor))
    await inTx((c) =>
      c.query('UPDATE content_items SET has_second_person = true WHERE id = $1', [clean.item.id]),
    )
    await fails(
      inTx(async (c) =>
        c.query('UPDATE posting_plan_rows SET manifest_id = $2 WHERE id = $1', [
          marked.id,
          await manifest(c, clean.modelId),
        ]),
      ),
      dbErrorCodes.secondPersonOnOnlyFans,
    )
    // A montage waits on OnlyFans; inserting the object with a second person is refused.
    const waiting = await inTx(async (c) =>
      planRow(c, onlyfans, 'wall', {
        manifest_id: null,
        expected_type: 'PPV',
        input_manifest_id: await manifest(c, modelId),
      }),
    )
    await fails(
      inTx(async (c) =>
        c.query('UPDATE posting_plan_rows SET item_id = $2, manifest_id = $3 WHERE id = $1', [
          waiting.id,
          item.id,
          await manifest(c, modelId),
        ]),
      ),
      dbErrorCodes.secondPersonOnOnlyFans,
    )
  })

  it('a late flag cancels the open OnlyFans rows of the object; marked rows and Fansly stay', async () => {
    const { fansly, onlyfans, item } = await setup(false)
    const actor = await inTx((c) => agent(c))
    const [open, marked, other] = await inTx(async (c) => [
      await planRow(c, onlyfans, 'wall', { item_id: item.id }),
      await markedRow(c, onlyfans, 'vault', item.id, actor),
      await planRow(c, fansly, 'wall', { item_id: item.id }),
    ])
    await inTx((c) =>
      c.query('UPDATE content_items SET has_second_person = true WHERE id = $1', [item.id]),
    )
    const { rows } = await pool.query(
      'SELECT id, cancelled_at, cancel_reason FROM posting_plan_rows WHERE id = ANY($1)',
      [[open?.id, marked?.id, other?.id]],
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(open?.id)).toMatchObject({ cancel_reason: 'second_person' })
    expect(byId.get(marked?.id)?.cancelled_at).toBeNull()
    expect(byId.get(other?.id)?.cancelled_at).toBeNull()
    // The cancellation is in the journal with the flag's request.
    const journal = await pool.query(
      `SELECT count(*)::int AS n FROM action_log
        WHERE subject_kind = 'posting_plan_rows' AND subject_id = $1 AND before IS NOT NULL
          AND after ->> 'cancel_reason' = 'second_person'`,
      [open?.id],
    )
    expect(journal.rows[0].n).toBe(1)
  })

  it('race: the plan row first — the flag waits and then cancels it', async () => {
    const { onlyfans, item } = await setup(false)
    const planner = await pool.connect()
    const owner = await pool.connect()
    try {
      await planner.query('BEGIN')
      await journalContext(planner)
      const row = await planRow(planner, onlyfans, 'wall', { item_id: item.id })
      await owner.query('BEGIN')
      await journalContext(owner)
      const flag = owner.query('UPDATE content_items SET has_second_person = true WHERE id = $1', [
        item.id,
      ])
      // The flag waits on the row lock the plan row took on its object.
      const waited = await Promise.race([
        flag.then(() => 'done'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
      ])
      expect(waited).toBe('waiting')
      await planner.query('COMMIT')
      await flag
      await owner.query('COMMIT')
      const { rows } = await pool.query(
        'SELECT cancel_reason FROM posting_plan_rows WHERE id = $1',
        [row.id],
      )
      expect(rows[0].cancel_reason).toBe('second_person')
    } finally {
      await planner.query('ROLLBACK').catch(() => undefined)
      await owner.query('ROLLBACK').catch(() => undefined)
      planner.release()
      owner.release()
    }
  })

  it('race: the flag first — the plan row waits and then is refused', async () => {
    const { onlyfans, item } = await setup(false)
    const planner = await pool.connect()
    const owner = await pool.connect()
    try {
      await owner.query('BEGIN')
      await journalContext(owner)
      await owner.query('UPDATE content_items SET has_second_person = true WHERE id = $1', [
        item.id,
      ])
      await planner.query('BEGIN')
      await journalContext(planner)
      const m = await manifest(planner, onlyfans.modelId)
      const insertRow = planRow(planner, onlyfans, 'wall', { item_id: item.id, manifest_id: m })
      const outcome = insertRow.then(
        () => 'inserted',
        (error: pg.DatabaseError) => error.code,
      )
      const waited = await Promise.race([
        outcome,
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
      ])
      expect(waited).toBe('waiting')
      await owner.query('COMMIT')
      expect(await outcome).toBe(dbErrorCodes.secondPersonOnOnlyFans)
    } finally {
      await planner.query('ROLLBACK').catch(() => undefined)
      await owner.query('ROLLBACK').catch(() => undefined)
      planner.release()
      owner.release()
    }
  })
})

describe('evidence and placements (schema §3.6, §9.2, §9.4)', () => {
  async function placement(modelId: string, extra: Row = {}): Promise<Row> {
    return inTx(async (c) =>
      insert(c, 'placements', { ...(await factory('placements')(c, modelId)), ...extra }),
    )
  }

  function evidence(placementRow: Row, extra: Row): Promise<Row> {
    return inTx((c) =>
      insert(c, 'placement_evidence', {
        model_id: placementRow.model_id,
        placement_id: placementRow.id,
        dedup_key: `k:${Math.random()}`,
        ...extra,
      }),
    )
  }

  it('the triple: manual_reject never exact, manual confirm always exact, a claim always a claim, Hub needs its observation', async () => {
    const modelId = await inTx((c) => newModel(c))
    const on = await placement(modelId)
    const triple = 'placement_evidence_triple'
    await fails(
      evidence(on, { source: 'manual', kind: 'manual_reject', strength: 'exact' }),
      '23514',
      triple,
    )
    await fails(
      evidence(on, { source: 'manual', kind: 'manual_reject', strength: 'claim' }),
      '23514',
      triple,
    )
    await expect(
      evidence(on, { source: 'manual', kind: 'manual_reject', strength: null }),
    ).resolves.toBeTruthy()
    await fails(
      evidence(on, { source: 'manual', kind: 'manual_confirm', strength: null }),
      '23514',
      triple,
    )
    await fails(
      evidence(on, { source: 'manual', kind: 'manual_confirm', strength: 'candidate' }),
      '23514',
      triple,
    )
    await fails(
      evidence(on, { source: 'import', kind: 'manual_confirm', strength: 'exact' }),
      '23514',
      triple,
    )
    const claim = await inTx((c) => make(c, 'legacy_claims', modelId))
    await fails(
      evidence(on, {
        source: 'import',
        kind: 'legacy_claim',
        strength: 'exact',
        legacy_claim_id: claim.id,
      }),
      '23514',
      triple,
    )
    await fails(
      evidence(on, { source: 'hub', kind: 'observed', strength: 'exact' }),
      '23514',
      triple,
    )
    await fails(
      evidence(on, { source: 'manual', kind: 'retract', strength: null }),
      '23514',
      'placement_evidence_retract',
    )
  })

  it('a retraction takes back one confirmation once; evidence is never updated', async () => {
    const modelId = await inTx((c) => newModel(c))
    const on = await placement(modelId)
    const confirmed = await evidence(on, {
      source: 'manual',
      kind: 'manual_confirm',
      strength: 'exact',
    })
    const retract = { source: 'manual', kind: 'retract', strength: null, corrects_id: confirmed.id }
    await expect(evidence(on, retract)).resolves.toBeTruthy()
    await fails(evidence(on, retract), '23505', 'placement_evidence_corrects_once')
    await fails(
      inTx((c) =>
        c.query("UPDATE placement_evidence SET payload = '{}' WHERE id = $1", [confirmed.id]),
      ),
      '42501',
    )
  })

  it('one publication — one placement per surface; the same post on the wall and in FYP is two', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { on } = await inTx(async (c) => ({ on: await page(c, modelId, 'fansly') }))
    const post = (surface: string) =>
      inTx((c) =>
        insert(c, 'placements', {
          model_id: modelId,
          account_id: on.accountId,
          surface_id: on.surfaces[surface],
          occurrence_kind: 'post',
          external_post_ref: 'post-1',
          occurred_at: new Date().toISOString(),
          occurred_source: 'hub',
          surface_source: 'hub',
          origin: 'hub',
        }),
      )
    await post('wall')
    await expect(post('fyp')).resolves.toBeTruthy()
    await fails(post('wall'), '23505', 'placements_post')
    // A placement without a time is only a claim without a date.
    await fails(
      inTx((c) =>
        insert(c, 'placements', {
          model_id: modelId,
          account_id: on.accountId,
          surface_id: on.surfaces.vault,
          occurrence_kind: 'manual',
          surface_source: 'import',
          origin: 'import',
        }),
      ),
      '23514',
      'placements_time',
    )
  })

  it('a legacy claim resolves to exactly one target', async () => {
    const modelId = await inTx((c) => newModel(c))
    const claim = await inTx((c) => make(c, 'legacy_claims', modelId))
    const [item, order] = await inTx(async (c) => [
      await make(c, 'content_items', modelId),
      await make(c, 'custom_orders', modelId),
    ])
    await fails(
      inTx((c) =>
        c.query(
          `UPDATE legacy_claims SET resolution = 'resolved', resolved_at = now(),
                  resolved_item_id = $2, resolved_order_id = $3 WHERE id = $1`,
          [claim.id, item?.id, order?.id],
        ),
      ),
      '23514',
      'legacy_claims_resolved',
    )
    await inTx((c) =>
      c.query(
        `UPDATE legacy_claims SET resolution = 'resolved', resolved_at = now(),
                resolved_item_id = $2 WHERE id = $1`,
        [claim.id, item?.id],
      ),
    )
  })
})
