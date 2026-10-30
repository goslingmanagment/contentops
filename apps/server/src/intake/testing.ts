import { randomUUID } from 'node:crypto'
import {
  bootstrap,
  createDb,
  createPool,
  type Db,
  enqueueWork,
  SYSTEM_ACTOR,
  type WorkHandler,
  WorkRunner,
  withActorTx,
} from '@contentops/db'
import { createTestDatabase, type TestDatabase } from '@contentops/db/testing'
import {
  type CloudSource,
  createDropboxSource,
  createYandexDiskSource,
  type RetryPolicy,
} from '@contentops/sources'
import {
  type FakeDropbox,
  type FakeYandexDisk,
  recordingRetry,
  startFakeDropbox,
  startFakeYandexDisk,
} from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { vi } from 'vitest'
import { createWorkGate } from '../work-gate'
import type { SourceFactory, SourceRow } from './source-client'

/**
 * A model with both cloud sources on fake servers (SPEC §12.0: external systems are fake
 * HTTP servers; no live keys in CI). Tests drive the real works through `WorkRunner`.
 */

export const LORA_ROOT = '/Lora'

export function intakeBootstrap() {
  const counters = Object.fromEntries(
    ['PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW', 'PRM'].map((type) => [
      type,
      { next_number: 1, legacy: type === 'PPV' },
    ]),
  )
  return {
    models: [
      {
        code: 'lora',
        title: 'Лора',
        title_genitive: 'Лоры',
        accounts: [{ code: 'lora-1', platform: 'fansly', title: 'Fansly 1', handle: 'LoraVie' }],
        id_counters: counters,
        sources: [
          { label: 'Dropbox', kind: 'dropbox', root: LORA_ROOT, credentials_ref: 'TEST_DROPBOX' },
          {
            label: 'Я.Диск',
            kind: 'yandex_disk',
            root: `disk:${LORA_ROOT}`,
            credentials_ref: 'TEST_YDISK',
          },
        ],
      },
    ],
    owner: { login: 'owner', display_name: 'Владелец', gender: 'm' },
  }
}

export interface IntakeHarness {
  db: Db
  pool: ReturnType<typeof createPool>
  database: TestDatabase
  modelId: string
  yandex: FakeYandexDisk
  dropbox: FakeDropbox
  sources: { yandex: SourceRow; dropbox: SourceRow }
  factory: SourceFactory
  /** Retry pauses the clients would have taken. */
  delays: number[]
  close(): Promise<void>
}

export async function intakeHarness(
  options: { recentLimit?: number; pageSize?: number } = {},
): Promise<IntakeHarness> {
  const database = await createTestDatabase()
  const pool = createPool(database.url(), { max: 10 })
  const db = createDb(pool)
  await bootstrap(db, intakeBootstrap(), { env: { CONTENTOPS_OWNER_PASSWORD: 'owner-password' } })
  const yandex = await startFakeYandexDisk()
  const dropbox = await startFakeDropbox()
  yandex.tree.addFolder(LORA_ROOT)
  dropbox.tree.addFolder(LORA_ROOT)
  const { policy, delays } = recordingRetry({ attempts: 2 })
  const retry: RetryPolicy = policy
  const factory: SourceFactory = (source): CloudSource =>
    source.kind === 'yandex_disk'
      ? createYandexDiskSource({
          token: yandex.token,
          root: source.rootPath,
          apiBase: yandex.url,
          retry,
          ...(options.recentLimit ? { recentLimit: options.recentLimit } : {}),
          ...(options.pageSize ? { pageSize: options.pageSize } : {}),
        })
      : createDropboxSource({
          token: dropbox.token,
          root: source.rootPath,
          apiBase: dropbox.url,
          contentBase: dropbox.url,
          retry,
          ...(options.pageSize ? { pageSize: options.pageSize } : {}),
        })
  const { rows } = await db.execute<{
    id: string
    model_id: string
    kind: 'yandex_disk' | 'dropbox'
    root_path: string
    credentials_ref: string
    label: string
  }>(sql`SELECT id, model_id, kind, root_path, credentials_ref, label FROM sources`)
  const row = (kind: string): SourceRow => {
    const found = rows.find((candidate) => candidate.kind === kind)
    if (!found) throw new Error(`no ${kind} source`)
    return {
      id: found.id,
      modelId: found.model_id,
      modelCode: 'lora',
      modelTimezone: 'Europe/Moscow',
      kind: found.kind,
      label: found.label,
      rootPath: found.root_path,
      credentialsRef: found.credentials_ref,
    }
  }
  const sources = { yandex: row('yandex_disk'), dropbox: row('dropbox') }
  return {
    db,
    pool,
    database,
    modelId: sources.yandex.modelId,
    yandex,
    dropbox,
    sources,
    factory,
    delays,
    async close() {
      await Promise.all([yandex.close(), dropbox.close()])
      await pool.end()
    },
  }
}

/** Turns a switch on or off for the model, as «Интеграции» does. */
export async function setSwitch(db: Db, key: string, modelId: string, on: boolean) {
  await withActorTx(
    db,
    { actor: SYSTEM_ACTOR('test'), action: 'test.switch', requestId: randomUUID() },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO policy_settings (model_id, key, value)
        VALUES (${modelId}::uuid, ${key}, ${JSON.stringify(on)}::jsonb)
        ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value`)
      if (on) {
        await tx.execute(sql`
          UPDATE work_operations SET paused_reason = NULL, next_attempt_at = now()
           WHERE paused_reason = ${`switch_off:${key}`} AND state IN ('pending', 'retry_wait')`)
      }
    },
  )
}

export interface WorkOutcome {
  id: string
  state: string
  error_code: string | null
  paused_reason: string | null
  report: Record<string, unknown> | null
  next_attempt_at: string
}

/** Runs one work of `kind` through a runner of role `worker` with the real gate. */
export async function runWork(
  db: Db,
  input: {
    modelId: string
    kind: 'scan' | 'fetch' | 'hash' | 'register' | 'propose'
    handlers: Partial<Record<string, WorkHandler>>
    scope?: string
    dataset?: string
    sourceRevisionId?: string
    draftId?: string
    /** Run this already queued work instead of queueing a new one. */
    workId?: string
    /** Stop waiting when the work is paused by a switch. */
    until?: (outcome: WorkOutcome) => boolean
  },
): Promise<WorkOutcome> {
  const key = `test:${randomUUID()}`
  const { work } = input.workId
    ? { work: { id: input.workId } }
    : await withActorTx(
        db,
        { actor: SYSTEM_ACTOR('test'), action: 'test.enqueue', requestId: randomUUID() },
        (tx) =>
          enqueueWork(tx, {
            modelId: input.modelId,
            kind: input.kind,
            workKey: key,
            scope: input.scope ?? null,
            dataset: input.dataset ?? null,
            sourceRevisionId: input.sourceRevisionId ?? null,
            draftId: input.draftId ?? null,
          }),
      )
  const runner = new WorkRunner({
    db,
    role: 'worker',
    handlers: input.handlers as never,
    gate: createWorkGate(),
    pollMs: 20,
    leaseMs: 5_000,
    backoffMs: () => 60_000,
    maxAttempts: 3,
    stopTimeoutMs: 1_000,
  })
  runner.start()
  try {
    return await vi.waitFor(
      async () => {
        const outcome = await workRow(db, work.id)
        const done =
          ['succeeded', 'failed', 'cancelled'].includes(outcome.state) ||
          (outcome.state === 'retry_wait' && outcome.paused_reason !== null) ||
          (outcome.state === 'retry_wait' && outcome.error_code !== null) ||
          (input.until?.(outcome) ?? false)
        if (!done) throw new Error(`work ${work.id} is ${outcome.state}`)
        return outcome
      },
      { timeout: 20_000, interval: 50 },
    )
  } finally {
    await runner.stop()
  }
}

export async function workRow(db: Db, id: string): Promise<WorkOutcome> {
  const { rows } = await db.execute<WorkOutcome & Record<string, unknown>>(sql`
    SELECT id, state, error_code, paused_reason, report, next_attempt_at::text
      FROM work_operations WHERE id = ${id}::uuid`)
  const [row] = rows
  if (!row) throw new Error(`no work ${id}`)
  return row
}

/** Row counts of the intake tables of a model. */
export async function intakeCounts(db: Db) {
  const { rows } = await db.execute(sql`SELECT
    (SELECT count(*) FROM source_objects)::int AS objects,
    (SELECT count(*) FROM source_paths)::int AS paths,
    (SELECT count(*) FROM source_revisions)::int AS revisions,
    (SELECT count(*) FROM inbox_groups)::int AS groups,
    (SELECT count(*) FROM inbox_drafts)::int AS drafts,
    (SELECT count(*) FROM action_log WHERE entry_kind = 'change')::int AS changes`)
  return rows[0] as Record<
    'objects' | 'paths' | 'revisions' | 'groups' | 'drafts' | 'changes',
    number
  >
}

/**
 * Runs the queued works of `kinds` (with the real gate) until none is due: what failed waits
 * in `retry_wait` a minute and is left alone. Returns the rows it ran.
 */
export async function drain(
  db: Db,
  kinds: readonly string[],
  handlers: Partial<Record<string, WorkHandler>>,
): Promise<WorkOutcome[]> {
  const started = new Date()
  const runner = new WorkRunner({
    db,
    role: 'worker',
    handlers: handlers as never,
    gate: createWorkGate(),
    pollMs: 20,
    leaseMs: 5_000,
    backoffMs: () => 60_000,
    maxAttempts: 3,
    stopTimeoutMs: 1_000,
  })
  runner.start()
  try {
    await vi.waitFor(
      async () => {
        const { rows } = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM work_operations
           WHERE kind = ANY (${sql.param([...kinds])}::text[])
             AND (state = 'running'
                  OR (state IN ('pending', 'retry_wait') AND paused_reason IS NULL
                      AND next_attempt_at <= now()))`)
        if ((rows[0]?.n ?? 0) > 0) throw new Error('works still due')
      },
      { timeout: 20_000, interval: 50 },
    )
  } finally {
    await runner.stop()
  }
  const { rows } = await db.execute<WorkOutcome & Record<string, unknown>>(sql`
    SELECT id, state, error_code, paused_reason, report, next_attempt_at::text
      FROM work_operations
     WHERE kind = ANY (${sql.param([...kinds])}::text[])
       AND (finished_at >= ${started.toISOString()}::timestamptz
            OR (state = 'retry_wait' AND next_attempt_at > now()))
     ORDER BY created_at`)
  return rows
}
