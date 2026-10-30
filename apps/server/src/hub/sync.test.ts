import { randomUUID } from 'node:crypto'
import { formatClock, formatStamp } from '@contentops/contracts/format'
import { type Db, enqueueWork, SYSTEM_ACTOR, WorkRunner, withActorTx } from '@contentops/db'
import { type FakeHub, startFakeHub } from '@contentops/hub/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from '../testing/server'
import { createWorkGate } from '../work-gate'
import { hubStreams, hubSyncHandler } from './sync'
import {
  attachment,
  enqueueHub,
  fakeClient,
  type PageIds,
  pageIds,
  post,
  runHubWork,
  seedFansly,
  setHubPage,
  setReceive,
  syncOnce,
  workOutcome,
} from './testing'

/**
 * PLAN 5, SPEC §7, §8, §8.1: the hourly Hub poll mirrors posts, attachments, platform files,
 * the vault and the Fansly statistics of a page into the observation log and current rows,
 * on a fake Hub. Initial sync and replay, the overlap windows, the attachment set replaced
 * whole, A→B→A, the capabilities check, a refused key, limits and temporary errors, the switch
 * with a pending and a running sync, a restart while off and switching on without duplicates.
 */

let server: TestServer
let db: Db
let hub: FakeHub
let owner: string
let lora1: PageIds
let loraOf: PageIds
let ari1: PageIds

const HOUR = 3_600_000

beforeAll(async () => {
  server = await testServer({ secrets: { hub: true } })
  db = server.db
  hub = await startFakeHub()
  hub.setNow(new Date())
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  lora1 = await pageIds(db, 'lora-1')
  loraOf = await pageIds(db, 'lora-of')
  ari1 = await pageIds(db, 'ari-1')
  await setHubPage(db, 'lora-1', 'page-a')
  await setHubPage(db, 'lora-of', 'page-b')
  await setHubPage(db, 'ari-1', 'page-c')
  seedFansly(hub, 'page-a', new Date())
})
afterAll(async () => {
  await hub?.close()
  await server?.close()
})

const options = () => ({ client: () => fakeClient(hub).client })

async function count(table: string, page: PageIds, where = sql`true`): Promise<number> {
  const column = table === 'hub_post_attachments' ? sql`p.account_id` : sql`t.account_id`
  const join =
    table === 'hub_post_attachments'
      ? sql`JOIN hub_posts p ON p.model_id = t.model_id AND p.id = t.post_id`
      : sql``
  const { rows } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${sql.raw(table)} t ${join}
     WHERE ${column} = ${page.accountId}::uuid AND ${where}`)
  return rows[0]?.n ?? 0
}

const observations = (page: PageIds, dataset: string) =>
  count('hub_observations', page, sql`t.dataset = ${dataset}`)

async function attachmentsOf(page: PageIds, postRef: string): Promise<string[]> {
  const { rows } = await db.execute<{ hub_key: string }>(sql`
    SELECT a.hub_key FROM hub_post_attachments a
      JOIN hub_posts p ON p.model_id = a.model_id AND p.id = a.post_id
     WHERE p.account_id = ${page.accountId}::uuid AND p.post_ref = ${postRef}
     ORDER BY a.hub_key`)
  return rows.map((row) => row.hub_key)
}

interface StateRow {
  last_success_at: string | null
  watermark_at: string | null
  last_daily_at: string | null
  next_full_at: string | null
  hub_succeeded_at: string | null
  available: boolean
  unavailable_reason: string | null
  last_error: string | null
  blockers: string[] | null
}

async function state(page: PageIds, dataset: string): Promise<StateRow | undefined> {
  const { rows } = await db.execute<StateRow & Record<string, unknown>>(sql`
    SELECT last_success_at::text, watermark_at::text, last_daily_at::text, next_full_at::text,
           hub_succeeded_at::text, available, unavailable_reason, last_error, blockers
      FROM hub_sync_state
     WHERE account_id = ${page.accountId}::uuid AND dataset = ${dataset}`)
  return rows[0]
}

/** Moves the boundary of a stream, as if the runs had been earlier (database clock). */
async function shiftState(page: PageIds, dataset: string, set: ReturnType<typeof sql>) {
  await withActorTx(
    db,
    { actor: SYSTEM_ACTOR('test'), action: 'test.shift', requestId: randomUUID() },
    (tx) =>
      tx.execute(sql`
        UPDATE hub_sync_state SET ${set}
         WHERE account_id = ${page.accountId}::uuid AND dataset = ${dataset}`),
  )
}

const datasetBodies = (since: number) =>
  hub
    .calls('dataset')
    .slice(since)
    .map((request) => request.json as { filters?: { field: string; op: string; value: string }[] })

async function integration(id: string) {
  const response = await call(server.app, {
    method: 'GET',
    url: '/api/v1/admin/integrations',
    as: owner,
  })
  expect(response.statusCode).toBe(200)
  return response.json().items.find((item: { id: string }) => item.id === id)
}

describe('initial sync and replay', () => {
  beforeAll(() => setReceive(db, lora1, true))

  it('reads a new page in full and mirrors posts with their attachments', async () => {
    const run = await syncOnce(db, lora1, 'posts', options())
    expect(run.state).toBe('succeeded')
    expect(run.report).toMatchObject({ mode: 'full', reason: 'first', posts: 3, attachments: 4 })
    expect(await count('hub_posts', lora1)).toBe(3)
    expect(await attachmentsOf(lora1, 'post-1')).toEqual(['post-1:0::main', 'post-1:1::main'])
    expect(await attachmentsOf(lora1, 'post-2')).toEqual([
      'post-2:0::main',
      'post-2:0::offer_preview',
    ])
    expect(await attachmentsOf(lora1, 'post-3')).toEqual([])
    expect(await observations(lora1, 'posts')).toBe(3)
    expect(await observations(lora1, 'post_attachments')).toBe(4)
    const posts = await state(lora1, 'posts')
    const success = Date.parse(posts?.last_success_at ?? '')
    expect(Date.parse(posts?.watermark_at ?? '')).toBe(success - 3 * HOUR)
    expect(Date.parse(posts?.next_full_at ?? '')).toBe(success + 30 * 24 * HOUR)
    expect(posts?.last_daily_at).toBe(posts?.last_success_at)
    // Fansly has no `sync_streams` rows: Hub's latest sighting of a post is its freshness.
    expect(posts?.hub_succeeded_at).not.toBeNull()
    expect(posts?.blockers).toContain('claim_not_declared')
  })

  it('mirrors platform files, the creator vault and the statistics', async () => {
    expect((await syncOnce(db, lora1, 'raw_media', options())).state).toBe('succeeded')
    expect(await count('hub_raw_media', lora1)).toBe(4)
    const { rows: names } = await db.execute<{ filename_norm: string }>(sql`
      SELECT filename_norm FROM hub_raw_media WHERE account_id = ${lora1.accountId}::uuid
       ORDER BY filename_norm LIMIT 1`)
    expect(names[0]?.filename_norm).toBe('file-1')

    expect((await syncOnce(db, lora1, 'vault_media', options())).state).toBe('succeeded')
    expect(await count('hub_vault_albums', lora1)).toBe(1)
    expect(await count('hub_vault_media', lora1)).toBe(2)
    expect((await state(lora1, 'vault_media'))?.hub_succeeded_at).not.toBeNull()

    const stats = await syncOnce(db, lora1, 'creator_stats', options())
    expect(stats.report).toMatchObject({ views: 1, likes: 1 })
    expect(await observations(lora1, 'creator_stats_media_daily')).toBe(1)
    expect(await observations(lora1, 'creator_stats_media_likes')).toBe(1)
  })

  it('a replay without new rows adds nothing and only moves last_seen_at', async () => {
    const before = await db.execute<{ at: string }>(sql`
      SELECT max(last_seen_at)::text AS at FROM hub_posts WHERE account_id = ${lora1.accountId}::uuid`)
    const run = await syncOnce(db, lora1, 'posts', options())
    expect(run.state).toBe('succeeded')
    expect(run.report).toMatchObject({ mode: 'hourly', posts_changed: 0, attachments_changed: 0 })
    expect(await observations(lora1, 'posts')).toBe(3)
    expect(await observations(lora1, 'post_attachments')).toBe(4)
    const after = await db.execute<{ at: string }>(sql`
      SELECT max(last_seen_at)::text AS at FROM hub_posts WHERE account_id = ${lora1.accountId}::uuid`)
    expect(Date.parse(after.rows[0]?.at ?? '')).toBeGreaterThan(
      Date.parse(before.rows[0]?.at ?? ''),
    )
    for (const dataset of ['raw_media', 'vault_media', 'creator_stats']) {
      const again = await syncOnce(db, lora1, dataset, options())
      expect(again.state).toBe('succeeded')
    }
    expect(await observations(lora1, 'raw_media')).toBe(4)
    expect(await observations(lora1, 'vault_media')).toBe(2)
    expect(await observations(lora1, 'creator_stats_media_daily')).toBe(1)
  })
})

describe('overlap windows in database terms', () => {
  it('hourly reads rowUpdatedAt from the last success minus 3 h', async () => {
    await shiftState(
      lora1,
      'posts',
      sql`last_success_at = now() - interval '2 hours',
      last_daily_at = now() - interval '2 hours'`,
    )
    const now = Date.now()
    // Changed long ago (before the window) and recently (inside it).
    hub.put('posts', 'page-a', [
      {
        ...post(
          'post-1',
          hub.rows('posts', 'page-a')[0]?.fields.publishedAt as string,
          'Old change',
          2,
        ),
      },
    ])
    const old = hub.rows('posts', 'page-a').find((row) => row.key === 'post-1')
    if (old) old.fields.rowUpdatedAt = new Date(now - 6 * HOUR).toISOString()
    const since = hub.calls('dataset').length
    const run = await syncOnce(db, lora1, 'posts', options())
    expect(run.report).toMatchObject({ mode: 'hourly', posts_changed: 0 })
    const success = Date.parse(String(run.report?.updated_since))
    expect(Math.abs(success - (now - 5 * HOUR))).toBeLessThan(60_000)
    const first = datasetBodies(since)[0]
    expect(first?.filters).toContainEqual({
      field: 'rowUpdatedAt',
      op: 'gte',
      value: run.report?.updated_since,
    })
  })

  it('once a day it reads a day back; a row changed 6 h ago comes in', async () => {
    await shiftState(
      lora1,
      'posts',
      sql`last_success_at = now() - interval '2 hours',
      last_daily_at = now() - interval '25 hours'`,
    )
    const run = await syncOnce(db, lora1, 'posts', options())
    expect(run.report).toMatchObject({ mode: 'daily', posts_changed: 1 })
    const since = Date.parse(String(run.report?.updated_since))
    expect(Math.abs(since - (Date.now() - 26 * HOUR))).toBeLessThan(60_000)
    expect(await observations(lora1, 'posts')).toBe(4)
  })

  it('a gap longer than a day and a month since the last full read re-read in full', async () => {
    await shiftState(lora1, 'posts', sql`last_success_at = now() - interval '26 hours'`)
    expect((await syncOnce(db, lora1, 'posts', options())).report).toMatchObject({
      mode: 'full',
      reason: 'gap',
    })
    await shiftState(lora1, 'posts', sql`next_full_at = now() - interval '1 minute'`)
    expect((await syncOnce(db, lora1, 'posts', options())).report).toMatchObject({
      mode: 'full',
      reason: 'monthly',
    })
    expect((await syncOnce(db, lora1, 'posts', options())).report).toMatchObject({
      mode: 'hourly',
    })
  })

  it('a Hub rebuild under a running read re-reads in full on the next attempt', async () => {
    let rebuilt = false
    const fetchWithRebuild: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init)
      if (!rebuilt && String(input).includes('/datasets/raw_media/')) {
        rebuilt = true
        hub.rebuild()
      }
      return answer
    }
    const handler = hubSyncHandler({
      client: () => fakeClient(hub, { fetch: fetchWithRebuild }).client,
      pageSize: 2,
    })
    const work = await enqueueHub(db, lora1, 'raw_media')
    const first = await runHubWork(db, work, handler)
    expect(first).toMatchObject({ state: 'retry_wait', error_code: 'hub_rebuilt' })
    await db.execute(
      sql`UPDATE work_operations SET next_attempt_at = now() WHERE id = ${work}::uuid`,
    )
    const second = await runHubWork(db, work, handler)
    expect(second.state).toBe('succeeded')
    expect(second.report).toMatchObject({ mode: 'full', reason: 'rebuild' })
    expect(await observations(lora1, 'raw_media')).toBe(4)
  })
})

describe('the attachment set of an affected post', () => {
  it('is replaced whole: a file taken off goes, an empty set empties the post', async () => {
    const posts = hub.rows('posts', 'page-a')
    const again = (key: string) => {
      const row = posts.find((candidate) => candidate.key === key)
      if (row) hub.put('posts', 'page-a', [{ key, fields: { ...row.fields, rowUpdatedAt: null } }])
    }
    hub.remove('post_attachments', 'page-a', ['post-1:1::main'])
    again('post-1')
    let run = await syncOnce(db, lora1, 'posts', options())
    expect(run.report).toMatchObject({ mode: 'hourly', attachments_removed: 1 })
    expect(await attachmentsOf(lora1, 'post-1')).toEqual(['post-1:0::main'])

    hub.remove('post_attachments', 'page-a', ['post-2:0::main', 'post-2:0::offer_preview'])
    again('post-2')
    run = await syncOnce(db, lora1, 'posts', options())
    expect(run.report).toMatchObject({ attachments_removed: 2 })
    expect(await attachmentsOf(lora1, 'post-2')).toEqual([])
  })

  it('a changed attachment alone affects its post; a full re-read replaces sets too', async () => {
    const published = hub.rows('posts', 'page-a').find((row) => row.key === 'post-3')?.fields
      .publishedAt as string
    hub.put('post_attachments', 'page-a', [
      attachment('post-3', published, 0, 'media-7', 'LIFE-003_01_page-a.mp4'),
    ])
    expect((await syncOnce(db, lora1, 'posts', options())).report).toMatchObject({
      mode: 'hourly',
    })
    expect(await attachmentsOf(lora1, 'post-3')).toEqual(['post-3:0::main'])

    // Taken off without the post being touched: only a full re-read sees it.
    hub.remove('post_attachments', 'page-a', ['post-3:0::main'])
    await shiftState(lora1, 'posts', sql`next_full_at = now() - interval '1 minute'`)
    const full = await syncOnce(db, lora1, 'posts', options())
    expect(full.report).toMatchObject({ mode: 'full', reason: 'monthly', attachments_removed: 1 })
    expect(await attachmentsOf(lora1, 'post-3')).toEqual([])
  })
})

describe('A→B→A', () => {
  it('is three observations of one post; the current row is A again', async () => {
    const row = hub.rows('posts', 'page-a').find((candidate) => candidate.key === 'post-3')
    if (!row) throw new Error('no post-3')
    const caption = String(row.fields.postText)
    const before = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM hub_observations
       WHERE account_id = ${lora1.accountId}::uuid AND dataset = 'posts' AND external_key = 'post-3'`)
    for (const text of ['Caption B', caption]) {
      hub.put('posts', 'page-a', [
        { key: 'post-3', fields: { ...row.fields, postText: text, rowUpdatedAt: null } },
      ])
      expect((await syncOnce(db, lora1, 'posts', options())).state).toBe('succeeded')
    }
    const { rows } = await db.execute<{
      sequence_no: number
      caption: string
      current: boolean
    }>(sql`
      SELECT o.sequence_no, o.payload ->> 'postText' AS caption,
             o.id = p.current_observation_id AS current
        FROM hub_observations o
        JOIN hub_posts p ON p.account_id = o.account_id AND p.post_ref = 'post-3'
       WHERE o.account_id = ${lora1.accountId}::uuid AND o.dataset = 'posts'
         AND o.external_key = 'post-3'
       ORDER BY o.sequence_no`)
    const n = before.rows[0]?.n ?? 0
    expect(rows.slice(n - 1).map((r) => [r.caption, r.current])).toEqual([
      [caption, false],
      ['Caption B', false],
      [caption, true],
    ])
  })
})

describe('capabilities', () => {
  beforeAll(async () => {
    seedFansly(hub, 'page-c', new Date())
    await setReceive(db, ari1, true)
  })

  it('a pinned field gone stops the poll of the page with the reason, before any read', async () => {
    hub.setField('raw_media', 'durationMs', null)
    const since = hub.calls('dataset').length
    try {
      const run = await syncOnce(db, ari1, 'posts', options())
      expect(run).toMatchObject({ state: 'failed', error_code: 'format_changed', attempt_no: 1 })
      expect(run.error_text).toContain('пропало поле durationMs')
      expect(hub.calls('dataset').length).toBe(since)
      expect((await state(ari1, 'posts'))?.available).toBe(false)
      const view = await integration('hub.ari-1')
      expect(view).toMatchObject({ state: 'down', down_reason: 'format_changed' })
      expect(view.line.text).toBe('Hub изменил формат данных — опрос остановлен до обновления')
    } finally {
      hub.setField('raw_media', 'durationMs', 'int')
    }
  })

  it('a field of another type stops it too; extra fields do not', async () => {
    hub.setField('posts', 'attachmentCount', 'string')
    try {
      const run = await syncOnce(db, ari1, 'raw_media', options())
      expect(run.error_text).toContain('сменило тип')
    } finally {
      hub.setField('posts', 'attachmentCount', 'int')
    }
    // The fake catalog carries fields beyond the pinned ones: the run reads in full after the
    // failed ones.
    const run = await syncOnce(db, ari1, 'posts', options())
    expect(run.state).toBe('succeeded')
    expect(run.report).toMatchObject({ mode: 'full', reason: 'failure', posts: 3 })
    expect((await state(ari1, 'posts'))?.available).toBe(true)
    expect((await integration('hub.ari-1')).state).toBe('working')
  })
})

describe('limits and temporary errors', () => {
  it('429 longer than the client waits goes back to the executor with Retry-After', async () => {
    hub.fail('rate_limit', { endpoint: 'dataset', times: 3, retryAfter: 120 })
    const work = await enqueueHub(db, lora1, 'raw_media')
    try {
      const run = await runHubWork(db, work, hubSyncHandler(options()))
      expect(run).toMatchObject({ state: 'retry_wait', error_code: 'rate_limited' })
      expect(Date.parse(run.next_attempt_at) - Date.now()).toBeGreaterThan(110_000)
      const view = await integration('hub.lora-1')
      expect(view).toMatchObject({ state: 'down', down_reason: 'unreachable' })
      expect(view.line.text).toMatch(/^Hub недоступен для Fansly 1 с \d\d:\d\d · повтор через/)
    } finally {
      hub.clearFailures()
    }
    // The next attempt after the pause catches up.
    await db.execute(
      sql`UPDATE work_operations SET next_attempt_at = now() WHERE id = ${work}::uuid`,
    )
    expect((await runHubWork(db, work, hubSyncHandler(options()))).state).toBe('succeeded')
    expect((await integration('hub.lora-1')).state).toBe('working')
  })

  it('5xx after the client retries waits for the backoff; a cut answer is retried at once', async () => {
    hub.fail('server_error', { endpoint: 'dataset', times: 2 })
    const work = await enqueueHub(db, lora1, 'raw_media')
    const run = await runHubWork(db, work, hubSyncHandler(options()))
    expect(run).toMatchObject({ state: 'retry_wait', error_code: 'hub_unavailable' })
    hub.clearFailures()
    await db.execute(
      sql`UPDATE work_operations SET next_attempt_at = now() WHERE id = ${work}::uuid`,
    )
    expect((await runHubWork(db, work, hubSyncHandler(options()))).state).toBe('succeeded')

    hub.fail('cut', { endpoint: 'dataset', times: 1 })
    const { client, delays } = fakeClient(hub)
    const cut = await syncOnce(db, lora1, 'raw_media', { client: () => client })
    expect(cut.state).toBe('succeeded')
    expect(delays).toHaveLength(1)
    expect(await observations(lora1, 'raw_media')).toBe(4)
  })

  it('Hub down holds no other work: the Hub slot is its own', async () => {
    let release: () => void = () => {}
    const hanging = new Promise<void>((resolve) => {
      release = resolve
    })
    const hubWork = await enqueueHub(db, lora1, 'raw_media')
    const { work: other } = await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test.enqueue', requestId: randomUUID() },
      (tx) =>
        enqueueWork(tx, { modelId: lora1.modelId, kind: 'scan', workKey: `scan:${randomUUID()}` }),
    )
    const runner = new WorkRunner({
      db,
      role: 'worker',
      handlers: {
        hub_sync: async ({ signal }) => {
          await Promise.race([
            hanging,
            new Promise((_, reject) => signal.addEventListener('abort', reject)),
          ])
          return {}
        },
        scan: async () => ({ report: { ok: true } }),
      },
      gate: createWorkGate(),
      pollMs: 20,
      stopTimeoutMs: 1_000,
    })
    runner.start()
    try {
      await vi.waitFor(
        async () => {
          expect((await workOutcome(db, other.id)).state).toBe('succeeded')
        },
        { timeout: 10_000, interval: 25 },
      )
      expect((await workOutcome(db, hubWork)).state).toBe('running')
    } finally {
      release()
      await runner.stop()
      await db.execute(sql`
        UPDATE work_operations SET state = 'cancelled', finished_at = now()
         WHERE id = ${hubWork}::uuid AND state IN ('pending', 'retry_wait')`)
    }
  })
})

describe('switch «Получать данные»', () => {
  beforeAll(() => {
    hub.put('posts', 'page-b', [
      post('of-1', new Date(Date.now() - 30 * HOUR).toISOString(), 'Test OF one', 0),
      post('of-2', new Date(Date.now() - 20 * HOUR).toISOString(), 'Test OF two', 0),
      post('of-3', new Date(Date.now() - 10 * HOUR).toISOString(), 'Test OF three', 0),
    ])
    hub.put('sync_streams', 'page-b', [
      {
        key: '8:posts',
        fields: {
          stream: 'posts',
          syncStatus: 'idle',
          cursorAt: null,
          succeededAt: new Date(Date.now() - HOUR).toISOString(),
          failedAt: null,
          consecutiveFailures: 0,
        },
      },
    ])
  })

  it('a pending sync waits with the reason and makes no request; a restart keeps it off', async () => {
    await setReceive(db, loraOf, true)
    const work = await enqueueHub(db, loraOf, 'posts')
    await setReceive(db, loraOf, false)
    const pageB = () => hub.requests.filter((request) => request.path.includes('/pages/page-b/'))
    const before = pageB().length
    const run = await runHubWork(db, work, hubSyncHandler(options()))
    expect(run).toMatchObject({ state: 'retry_wait', paused_reason: 'switch_off:hub.receive' })
    // A new runner (a restart of the worker) leaves it paused and silent.
    const again = await runHubWork(db, work, hubSyncHandler(options()), { claim: false })
    expect(again.paused_reason).toBe('switch_off:hub.receive')
    expect(pageB().length).toBe(before)
    const streams = await hubStreams(db, { configured: true, since: new Date(0) })
    expect(streams.some((stream) => stream.accountId === loraOf.accountId)).toBe(false)
    expect(streams.some((stream) => stream.accountId === lora1.accountId)).toBe(true)
    const view = await integration('hub.lora-of')
    expect(view).toMatchObject({ state: 'off', switches: { receive: false } })

    // Switched on: the paused work runs and catches up.
    await setReceive(db, loraOf, true)
    const done = await runHubWork(db, work, hubSyncHandler(options()))
    expect(done.state).toBe('succeeded')
    expect(await count('hub_posts', loraOf)).toBe(3)
    // OnlyFans pages have Hub's posts stream: its success is the freshness.
    const posts = await state(loraOf, 'posts')
    expect(Date.parse(posts?.hub_succeeded_at ?? '')).toBe(
      Date.parse(String(hub.rows('sync_streams', 'page-b')[0]?.fields.succeededAt)),
    )
    expect((await integration('hub.lora-of')).line.text).toBe(
      `Hub · посты на ${formatStamp(posts?.hub_succeeded_at ?? '', new Date().toISOString())}`,
    )
  })

  it('a running sync stops before its next request; switching on again adds no duplicates', async () => {
    const page = hub.rows('posts', 'page-b')
    hub.put(
      'posts',
      'page-b',
      page.map((row) => ({ key: row.key, fields: { ...row.fields, rowUpdatedAt: null } })),
    )
    await shiftState(loraOf, 'posts', sql`next_full_at = now() - interval '1 minute'`)
    const boundary = (await state(loraOf, 'posts'))?.last_success_at
    const observed = await observations(loraOf, 'posts')
    let seen = 0
    const switchingFetch: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init)
      if (String(input).includes('/datasets/posts/') && ++seen === 1) {
        await setReceive(db, loraOf, false)
      }
      return answer
    }
    const handler = hubSyncHandler({
      client: () => fakeClient(hub, { fetch: switchingFetch }).client,
      pageSize: 1,
    })
    const work = await enqueueHub(db, loraOf, 'posts')
    const run = await runHubWork(db, work, handler)
    expect(run).toMatchObject({ state: 'retry_wait', paused_reason: 'switch_off:hub.receive' })
    // The answer that was already sent is kept; no further request; the boundary stays.
    expect(seen).toBe(1)
    expect((await state(loraOf, 'posts'))?.last_success_at).toBe(boundary)

    await setReceive(db, loraOf, true)
    const done = await runHubWork(db, work, handler)
    expect(done.state).toBe('succeeded')
    expect(done.report).toMatchObject({ mode: 'full', reason: 'monthly' })
    expect(await observations(loraOf, 'posts')).toBe(observed)
    expect((await state(loraOf, 'posts'))?.last_success_at).not.toBe(boundary)
  })

  it('switched off, Hub gives no «не вышло»: the integration says off, not down', async () => {
    await setReceive(db, loraOf, false)
    const view = await integration('hub.lora-of')
    expect(view.state).toBe('off')
    expect(view.line.text).toBe('Hub выключен для OF Free — отметки работают')
    await setReceive(db, loraOf, true)
  })
})

describe('a refused key', () => {
  it('stops at once, says since when, and is not tried again until a restart', async () => {
    const before = new Date(Date.now() - 1_000)
    hub.revokeKey()
    try {
      const run = await syncOnce(db, lora1, 'raw_media', options())
      expect(run).toMatchObject({ state: 'failed', error_code: 'auth_rejected', attempt_no: 1 })
      expect(await hubStreams(db, { configured: true, since: before })).toEqual([])
      const view = await integration('hub.lora-1')
      expect(view).toMatchObject({ state: 'down', down_reason: 'token_rejected' })
      expect(view.line.text).toMatch(/^Hub для Fansly 1: токен не принят с \d\d:\d\d$/)
      // Another page of the same key says the same.
      expect((await integration('hub.ari-1')).down_reason).toBe('token_rejected')
    } finally {
      hub.restoreKey()
    }
    // A new key means a restart: the streams come back, a success clears the state.
    expect((await hubStreams(db, { configured: true, since: new Date() })).length).toBeGreaterThan(
      0,
    )
    const run = await syncOnce(db, lora1, 'raw_media', options())
    expect(run.report).toMatchObject({ mode: 'full', reason: 'failure' })
    expect((await integration('hub.lora-1')).state).toBe('working')
  })
})

describe('what the screens read', () => {
  it('«Интеграции»: three switches per page and Hub’s own freshness', async () => {
    const view = await integration('hub.lora-1')
    expect(view.switches).toEqual({ receive: true, auto_match: false, publish: false })
    const posts = await state(lora1, 'posts')
    expect(view.line.text).toBe(
      `Hub · посты на ${formatStamp(posts?.hub_succeeded_at ?? '', new Date().toISOString())}`,
    )
    const on = await call(server.app, {
      method: 'PATCH',
      url: '/api/v1/admin/integrations/hub.lora-1',
      as: owner,
      key: newKey(),
      body: { switches: { publish: true } },
    })
    expect(on.statusCode).toBe(200)
    expect(on.json().switches).toEqual({ receive: true, auto_match: false, publish: true })
  })

  it('Hub data older than a day is «временно недоступно: не обновлял посты с …»', async () => {
    await shiftState(lora1, 'posts', sql`hub_succeeded_at = now() - interval '30 hours'`)
    const view = await integration('hub.lora-1')
    expect(view).toMatchObject({ state: 'down', down_reason: 'stale' })
    const since = (await state(lora1, 'posts'))?.hub_succeeded_at ?? ''
    expect(view.line.text).toBe(
      `Hub не обновлял посты Fansly 1 с ${formatStamp(since, new Date().toISOString())}`,
    )
    expect(formatClock(since)).toMatch(/^\d\d:\d\d$/)
  })

  it('«Состояние»: the delay monitor over 30 days', async () => {
    const response = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/state',
      as: owner,
    })
    expect(response.statusCode).toBe(200)
    // Every fake post is seen by Hub two hours after it went out.
    expect(response.json().hub_latency).toEqual({
      typical_hours: 2,
      max_hours: 2,
      wait_window_hours: 8,
      warning: null,
    })
  })
})
