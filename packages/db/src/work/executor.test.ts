import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb, createPool, type Db, SYSTEM_ACTOR, type Tx, withActorTx } from '../client.ts'
import { isSwitchOn, resumeSwitch } from '../policy.ts'
import { createTestDatabase } from '../testing/index.ts'
import { killSwitchKeys, type WorkRole } from '../values.ts'
import { enqueueWork } from './enqueue.ts'
import {
  LeaseLostError,
  RunnerStoppedError,
  WorkDeferred,
  WorkError,
  type WorkHandler,
  WorkRunner,
  type WorkRunnerOptions,
} from './runner.ts'
import { WorkScheduler } from './scheduler.ts'

let pool: pg.Pool
let db: Db
const runners: WorkRunner[] = []

beforeAll(async () => {
  pool = createPool((await createTestDatabase()).url('app'), { max: 20 })
  db = createDb(pool)
})
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.stop()))
  // Runners take works of every model: leave nothing for the next test.
  await pool.query(`UPDATE work_operations SET state = 'cancelled', finished_at = now(),
    lease_owner = NULL, lease_until = NULL WHERE state IN ('pending', 'running', 'retry_wait')`)
})
afterAll(() => pool?.end())

const ctx = () => ({ actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() })

async function newModel(): Promise<{ modelId: string; accountId: string }> {
  return withActorTx(db, ctx(), async (tx) => {
    const code = `m${randomUUID().slice(0, 8)}`
    const model = await tx.execute<{ id: string }>(
      sql`INSERT INTO models (code, title, title_genitive) VALUES (${code}, ${code}, ${code}) RETURNING id`,
    )
    const modelId = model.rows[0]?.id ?? ''
    const account = await tx.execute<{ id: string }>(sql`
      INSERT INTO accounts (model_id, code, platform, title, handle, position)
      VALUES (${modelId}, ${`${code}-1`}, 'fansly', 'Fansly 1', ${code}, 1) RETURNING id`)
    return { modelId, accountId: account.rows[0]?.id ?? '' }
  })
}

function runner(
  role: WorkRole,
  handlers: WorkRunnerOptions['handlers'],
  options: Partial<WorkRunnerOptions> = {},
): WorkRunner {
  const created = new WorkRunner({
    db,
    role,
    handlers,
    pollMs: 20,
    leaseMs: 2_000,
    backoffMs: () => 30,
    stopTimeoutMs: 1_000,
    ...options,
  })
  runners.push(created)
  created.start()
  return created
}

async function work(id: string) {
  const { rows } = await pool.query(
    `SELECT state, attempt_no, fence_generation::int AS generation, lease_owner, lease_until,
            next_attempt_at <= now() AS due, paused_reason, failure_kind, error_code, output_ref,
            checkpoint, progress_num::int AS progress_num, progress_note, finished_at
       FROM work_operations WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function events(id: string) {
  const { rows } = await pool.query(
    `SELECT action, result, after FROM action_log
      WHERE subject_kind = 'work_operations' AND subject_id = $1 ORDER BY id`,
    [id],
  )
  return rows
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const until = (check: () => Promise<unknown> | unknown, timeout = 10_000) =>
  vi.waitFor(
    async () => {
      if (!(await check())) throw new Error('not yet')
    },
    { timeout, interval: 20 },
  )

const succeeded = (id: string) => until(async () => (await work(id))?.state === 'succeeded')

describe('enqueueWork', () => {
  it('writes in the caller transaction; a repeat returns the same row', async () => {
    const { modelId } = await newModel()
    const input = { modelId, kind: 'scan' as const, workKey: `scan:${randomUUID()}` }
    await expect(
      db.transaction(async (tx) => {
        await enqueueWork(tx, input)
        throw new Error('domain write failed')
      }),
    ).rejects.toThrow('domain write failed')
    const { rows } = await pool.query('SELECT 1 FROM work_operations WHERE work_key = $1', [
      input.workKey,
    ])
    expect(rows).toEqual([])

    const first = await db.transaction((tx) => enqueueWork(tx, input))
    const again = await enqueueWork(db, input)
    expect(first.created).toBe(true)
    expect(again).toMatchObject({ created: false, work: { id: first.work.id, state: 'pending' } })

    const global = { modelId: null, kind: 'verify_blobs' as const, workKey: 'verify:2026-10-30' }
    const [a, b] = await Promise.all([enqueueWork(db, global), enqueueWork(db, global)])
    expect(a?.work.id).toBe(b?.work.id)
    expect([a?.created, b?.created].sort()).toEqual([false, true])
  })
})

describe('WorkRunner', () => {
  it('two runners of one role take each work exactly once', async () => {
    const { modelId } = await newModel()
    const ids: string[] = []
    for (let i = 0; i < 30; i++) {
      ids.push((await enqueueWork(db, { modelId, kind: 'scan', workKey: `scan:${i}` })).work.id)
    }
    const runs: string[] = []
    const handler: WorkHandler = async ({ work: row }) => {
      runs.push(row.id)
      await new Promise((r) => setTimeout(r, 5))
      return { outputRef: row.workKey }
    }
    runner('worker', { scan: handler }, { limits: { general: 3 } })
    runner('worker', { scan: handler }, { limits: { general: 3 } })
    await until(async () => {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM work_operations WHERE model_id = $1 AND state = 'succeeded'",
        [modelId],
      )
      return rows[0].n === ids.length
    })
    expect(runs.sort()).toEqual([...ids].sort())
    const { rows } = await pool.query(
      'SELECT DISTINCT attempt_no, fence_generation::int AS g FROM work_operations WHERE model_id = $1',
      [modelId],
    )
    expect(rows).toEqual([{ attempt_no: 1, g: 1 }])
  })

  it('a role never takes kinds of another role', async () => {
    const { modelId } = await newModel()
    const scan = await enqueueWork(db, { modelId, kind: 'scan', workKey: 'scan:a' })
    const encode = await enqueueWork(db, { modelId, kind: 'encode_master', workKey: 'master:a' })
    const image = await enqueueWork(db, { modelId, kind: 'derive_image', workKey: 'image:a' })
    const imaging = runner('worker-image', { derive_image: async () => ({}) })
    await succeeded(image.work.id)
    await imaging.tick()
    expect(await work(scan.work.id)).toMatchObject({ state: 'pending', attempt_no: 0 })
    expect(await work(encode.work.id)).toMatchObject({ state: 'pending', attempt_no: 0 })
    expect(
      () => new WorkRunner({ db, role: 'worker-image', handlers: { scan: async () => ({}) } }),
    ).toThrow('scan belongs to worker, not worker-image')
  })

  it('keeps to the slot limits of the role', async () => {
    const { modelId } = await newModel()
    const gate = deferred()
    const a = await enqueueWork(db, { modelId, kind: 'encode_master', workKey: 'master:1' })
    const b = await enqueueWork(db, { modelId, kind: 'encode_master', workKey: 'master:2' })
    let concurrent = 0
    let peak = 0
    runner(
      'worker-video',
      {
        encode_master: async () => {
          peak = Math.max(peak, ++concurrent)
          await gate.promise
          concurrent--
          return {}
        },
      },
      { limits: { encode: 1 } },
    )
    await until(
      async () =>
        (await work(a.work.id))?.state === 'running' ||
        (await work(b.work.id))?.state === 'running',
    )
    await new Promise((r) => setTimeout(r, 100))
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM work_operations WHERE model_id = $1 AND state = 'running'",
      [modelId],
    )
    expect(rows[0].n).toBe(1)
    gate.resolve()
    await succeeded(a.work.id)
    await succeeded(b.work.id)
    expect(peak).toBe(1)
  })

  it('limits asked at each claim narrow a slot for the moment', async () => {
    const { modelId } = await newModel()
    const gate = deferred()
    const ids = await Promise.all(
      [1, 2, 3].map(
        async (n) =>
          (await enqueueWork(db, { modelId, kind: 'derive_image', workKey: `img:${n}` })).work.id,
      ),
    )
    let concurrent = 0
    let peak = 0
    let slow = true
    runner(
      'worker-image',
      {
        derive_image: async () => {
          peak = Math.max(peak, ++concurrent)
          await gate.promise
          concurrent--
          return {}
        },
      },
      { limits: { image: 3 }, dynamicLimits: async () => (slow ? { image: 1 } : {}) },
    )
    await until(async () => (await Promise.all(ids.map(work))).some((w) => w?.state === 'running'))
    await new Promise((r) => setTimeout(r, 100))
    expect(peak).toBe(1)
    slow = false
    gate.resolve()
    for (const id of ids) await succeeded(id)
  })

  it('a deferred work comes back later without counting an attempt', async () => {
    const { modelId } = await newModel()
    const { work: row } = await enqueueWork(db, {
      modelId,
      kind: 'export',
      workKey: `export:${randomUUID()}`,
    })
    let calls = 0
    runner('worker', {
      export: async () => {
        calls++
        if (calls < 3) throw new WorkDeferred(10, 'ждёт копию')
        return { outputRef: 'done' }
      },
    })
    await succeeded(row.id)
    expect(calls).toBe(3)
    expect(await work(row.id)).toMatchObject({ attempt_no: 1, output_ref: 'done' })
    expect((await events(row.id)).map((e) => e.action)).toEqual([
      'work.deferred',
      'work.deferred',
      'work.succeeded',
    ])
  })

  it('after a crash the work is picked up only when the lease expires', async () => {
    const { modelId } = await newModel()
    const { work: row } = await enqueueWork(db, { modelId, kind: 'scan', workKey: 'scan:crash' })
    // A process took the work and died: its lease is not renewed any more.
    const { rows } = await pool.query(
      `UPDATE work_operations SET state = 'running', lease_owner = 'crashed', attempt_no = 1,
              fence_generation = 1, started_at = now(), lease_until = now() + interval '600 ms'
        WHERE id = $1 RETURNING lease_until`,
      [row.id],
    )
    const expiredAt: Date = rows[0].lease_until
    let seen: { generation: number; attempt: number; afterLease: boolean } | undefined
    const taker = runner('worker', {
      scan: async ({ work: claimed }) => {
        const now = await pool.query('SELECT now() > $1::timestamptz AS after', [expiredAt])
        seen = {
          generation: claimed.fenceGeneration,
          attempt: claimed.attemptNo,
          afterLease: now.rows[0].after,
        }
        return {}
      },
    })
    await taker.tick()
    expect(await work(row.id)).toMatchObject({ lease_owner: 'crashed', state: 'running' })
    await succeeded(row.id)
    expect(seen).toEqual({ generation: 2, attempt: 2, afterLease: true })
  })

  it('a holder that lost the lease aborts and never writes its result', async () => {
    const { modelId } = await newModel()
    const { work: row } = await enqueueWork(db, { modelId, kind: 'scan', workKey: 'scan:stale' })
    const started = deferred()
    const release = deferred()
    let staleSignal: AbortSignal | undefined
    let checkpointError: unknown
    const channel = (code: string) => async (tx: Tx) => {
      await tx.execute(
        sql`INSERT INTO promo_channels (model_id, code, title) VALUES (${modelId}, ${code}, ${code})`,
      )
    }
    // No heartbeat within the lease: the lease runs out while the handler still works.
    const stale = runner(
      'worker',
      {
        scan: async ({ signal, checkpoint }) => {
          staleSignal = signal
          started.resolve()
          await release.promise
          checkpointError = await checkpoint({ progress: { num: 1 } }).catch((e: unknown) => e)
          return { outputRef: 'stale', commit: channel('from-stale') }
        },
      },
      { leaseMs: 300, heartbeatMs: 60_000 },
    )
    await started.promise
    await until(async () => {
      const { rows } = await pool.query(
        'SELECT lease_until < now() AS gone FROM work_operations WHERE id = $1',
        [row.id],
      )
      return rows[0].gone
    })
    runner('worker', { scan: async () => ({ outputRef: 'fresh', commit: channel('from-fresh') }) })
    await succeeded(row.id)
    release.resolve()
    await until(() => stale.active === 0)

    expect(checkpointError).toBeInstanceOf(LeaseLostError)
    expect(staleSignal?.aborted).toBe(true)
    expect(await work(row.id)).toMatchObject({
      state: 'succeeded',
      output_ref: 'fresh',
      generation: 2,
    })
    const { rows: channels } = await pool.query(
      'SELECT code FROM promo_channels WHERE model_id = $1 ORDER BY code',
      [modelId],
    )
    expect(channels.map((c) => c.code)).toEqual(['from-fresh'])
    expect((await events(row.id)).map((e) => [e.action, e.after.generation])).toEqual([
      ['work.succeeded', 2],
    ])
  })

  it('stopping the role returns the running work without counting an attempt', async () => {
    const { modelId } = await newModel()
    const { work: row } = await enqueueWork(db, { modelId, kind: 'fetch', workKey: 'fetch:stop' })
    let reason: unknown
    const first = runner('worker', {
      fetch: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reason = signal.reason
            reject(signal.reason)
          })
        }),
    })
    await until(async () => (await work(row.id))?.state === 'running')
    expect((await work(row.id))?.attempt_no).toBe(1)
    await first.stop()
    expect(reason).toBeInstanceOf(RunnerStoppedError)
    expect(await work(row.id)).toMatchObject({
      state: 'retry_wait',
      attempt_no: 0,
      lease_owner: null,
      lease_until: null,
      due: true,
      failure_kind: null,
    })
    runner('worker', { fetch: async () => ({}) })
    await succeeded(row.id)
    expect(await work(row.id)).toMatchObject({ attempt_no: 1, generation: 2 })
    expect((await events(row.id)).map((e) => [e.action, e.after.attempt])).toEqual([
      ['work.returned', 0],
      ['work.succeeded', 1],
    ])
  })

  it('retries with backoff, fails a permanent error at once and stops after max attempts', async () => {
    const { modelId } = await newModel()
    const flaky = await enqueueWork(db, { modelId, kind: 'hash', workKey: 'hash:flaky' })
    const broken = await enqueueWork(db, { modelId, kind: 'register', workKey: 'register:bad' })
    const hopeless = await enqueueWork(db, { modelId, kind: 'propose', workKey: 'propose:x' })
    const unlucky = await enqueueWork(db, { modelId, kind: 'export', workKey: 'export:x' })
    let exports = 0
    let tries = 0
    runner(
      'worker',
      {
        hash: async () => {
          tries++
          if (tries === 1) throw new WorkError('transient', 'ydisk_429', 'rate limited')
          return { report: { ok: true } }
        },
        register: async () => {
          throw new WorkError('permanent', 'bad_input', 'cannot register')
        },
        propose: async () => {
          throw new Error('boom')
        },
        export: async () => ({
          commit: async (tx) => {
            exports++
            if (exports === 1) {
              await tx.execute(
                sql`INSERT INTO promo_channels (model_id, code, title) VALUES (${modelId}, 'x', 'x')`,
              )
              throw new WorkError('transient', 'commit_conflict', 'domain write failed')
            }
          },
        }),
      },
      { maxAttempts: 2, limits: { general: 4 } },
    )
    await succeeded(flaky.work.id)
    expect(await work(flaky.work.id)).toMatchObject({ attempt_no: 2, failure_kind: null })
    await until(async () => (await work(broken.work.id))?.state === 'failed')
    expect(await work(broken.work.id)).toMatchObject({
      attempt_no: 1,
      failure_kind: 'permanent',
      error_code: 'bad_input',
    })
    await until(async () => (await work(hopeless.work.id))?.state === 'failed')
    expect(await work(hopeless.work.id)).toMatchObject({
      attempt_no: 2,
      failure_kind: 'transient',
      error_code: 'unexpected',
    })
    expect(
      (await events(flaky.work.id)).map((e) => [e.action, e.result, e.after.error_code]),
    ).toEqual([
      ['work.retry', 'ok', 'ydisk_429'],
      ['work.succeeded', 'ok', undefined],
    ])
    // The failed commit rolled back its domain write together with the finish.
    await succeeded(unlucky.work.id)
    expect(await work(unlucky.work.id)).toMatchObject({ attempt_no: 2 })
    const { rows: written } = await pool.query(
      "SELECT 1 FROM promo_channels WHERE model_id = $1 AND code = 'x'",
      [modelId],
    )
    expect(written).toEqual([])
    expect((await events(hopeless.work.id)).map((e) => [e.action, e.result])).toEqual([
      ['work.retry', 'ok'],
      ['work.failed', 'error'],
    ])
  })

  it('saves checkpoints and commits domain writes with the work in the journal', async () => {
    const { modelId } = await newModel()
    const { work: row } = await enqueueWork(db, { modelId, kind: 'fetch', workKey: 'fetch:cp' })
    // The output of a work holds its blob: the blob is registered first (FK on `blobs`).
    await pool.query(
      `INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key)
       VALUES ($1, 1, 'video/mp4', 'mp4', 'video', 'blobs/sha256/07/07/fetch-cp.mp4')`,
      [Buffer.alloc(32, 7)],
    )
    runner('worker', {
      fetch: async ({ checkpoint }) => {
        await checkpoint({
          checkpoint: { offset: 3_200 },
          progress: { num: 32, den: 58, note: '3,2 ГБ из 5,8' },
        })
        return {
          outputSha256: Buffer.alloc(32, 7),
          commit: async (tx) => {
            await tx.execute(
              sql`INSERT INTO promo_channels (model_id, code, title) VALUES (${modelId}, 'fetched', 'F')`,
            )
          },
        }
      },
    })
    await succeeded(row.id)
    expect(await work(row.id)).toMatchObject({
      checkpoint: { offset: 3_200 },
      progress_num: 32,
      progress_note: '3,2 ГБ из 5,8',
      lease_owner: null,
    })
    const { rows } = await pool.query(
      "SELECT work_id, action, actor_label FROM action_log WHERE subject_kind = 'promo_channels' AND subject_label = 'fetched'",
    )
    expect(rows).toEqual([{ work_id: row.id, action: 'work.succeeded', actor_label: 'worker' }])
  })

  it('pauses works of a switched-off area and runs them after the switch is on', async () => {
    const { modelId, accountId } = await newModel()
    const { work: row } = await enqueueWork(db, {
      modelId,
      kind: 'hub_sync',
      workKey: 'hub:posts:1',
      accountId,
    })
    let runs = 0
    const syncing = runner(
      'worker',
      {
        hub_sync: async () => {
          runs++
          return {}
        },
      },
      {
        gate: async (claimed, gateDb) =>
          (await isSwitchOn(gateDb, 'hub.receive', {
            modelId: claimed.modelId,
            accountId: claimed.accountId,
          }))
            ? null
            : 'hub.receive',
      },
    )
    await until(async () => (await work(row.id))?.paused_reason === 'switch_off:hub.receive')
    await syncing.tick()
    await new Promise((r) => setTimeout(r, 100))
    expect(await work(row.id)).toMatchObject({ state: 'retry_wait', attempt_no: 0 })
    expect(runs).toBe(0)

    await withActorTx(db, ctx(), async (tx) => {
      await tx.execute(sql`INSERT INTO policy_settings (key, value) VALUES ('hub.receive', 'true')`)
      expect(await resumeSwitch(tx, 'hub.receive')).toBeGreaterThanOrEqual(1)
    })
    await succeeded(row.id)
    expect(runs).toBe(1)
    expect((await events(row.id)).map((e) => e.action)).toEqual(['work.paused', 'work.succeeded'])
  })
})

describe('kill switches', () => {
  it('everything is off without settings; a refusal at any level wins', async () => {
    const { modelId, accountId } = await newModel()
    const scope = { modelId, accountId }
    for (const key of killSwitchKeys) {
      if (key === 'hub.receive') continue // switched on globally by the pause test
      expect(await isSwitchOn(db, key, scope), key).toBe(false)
    }
    await withActorTx(db, ctx(), async (tx) => {
      await tx.execute(sql`INSERT INTO policy_settings (key, value) VALUES ('hub.publish', 'true')`)
      await tx.execute(sql`INSERT INTO policy_settings (model_id, account_id, key, value)
        VALUES (${modelId}, ${accountId}, 'hub.publish', 'false')`)
      await tx.execute(sql`INSERT INTO policy_settings (model_id, key, value)
        VALUES (${modelId}, 'hub.auto_match', 'true')`)
      await tx.execute(sql`INSERT INTO policy_settings (key, value) VALUES ('ydisk.scan', NULL)`)
    })
    expect(await isSwitchOn(db, 'hub.publish', {})).toBe(true)
    expect(await isSwitchOn(db, 'hub.publish', { modelId })).toBe(true)
    expect(await isSwitchOn(db, 'hub.publish', scope)).toBe(false)
    expect(await isSwitchOn(db, 'hub.auto_match', scope)).toBe(true)
    expect(await isSwitchOn(db, 'hub.auto_match', {})).toBe(false)
    expect(await isSwitchOn(db, 'ydisk.scan', scope)).toBe(false)
  })
})

describe('WorkScheduler', () => {
  it('two schedulers insert one row per interval', async () => {
    const { modelId, accountId } = await newModel()
    const stream = {
      streamKey: `hub:${accountId}:posts`,
      kind: 'hub_sync' as const,
      modelId,
      accountId,
      dataset: 'posts',
      intervalMs: 3_600_000,
      windowed: true,
    }
    const a = new WorkScheduler({ db, streams: () => [stream] })
    const b = new WorkScheduler({ db, streams: () => [stream] })
    const first = await Promise.all([a.tick(), b.tick()])
    const second = await Promise.all([a.tick(), b.tick()])
    expect(first.reduce((sum, n) => sum + n, 0)).toBe(1)
    expect(second).toEqual([0, 0])
    const { rows } = await pool.query(
      `SELECT work_key, window_to - window_from AS width,
              date_trunc('hour', now()) = window_from AS aligned
         FROM work_operations WHERE stream_key = $1`,
      [stream.streamKey],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].work_key).toMatch(
      new RegExp(`^${stream.streamKey}@\\d{4}-\\d\\d-\\d\\dT\\d\\d:00:00\\.000Z$`),
    )
    expect(rows[0].aligned).toBe(true)
  })

  it('a busy stream skips intervals until its work finishes', async () => {
    const stream = { streamKey: 'backup', kind: 'backup' as const, modelId: null, intervalMs: 100 }
    const scheduler = new WorkScheduler({ db, streams: () => [stream] })
    expect(await scheduler.tick()).toBe(1)
    await new Promise((r) => setTimeout(r, 150))
    expect(await scheduler.tick()).toBe(0)
    await pool.query(
      "UPDATE work_operations SET state = 'succeeded', finished_at = now() WHERE stream_key = 'backup'",
    )
    expect(await scheduler.tick()).toBe(1)
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n, count(DISTINCT work_key)::int AS keys FROM work_operations WHERE stream_key = 'backup'",
    )
    expect(rows[0]).toEqual({ n: 2, keys: 2 })
  })
})
