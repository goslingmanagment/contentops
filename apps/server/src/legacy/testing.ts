import { randomUUID } from 'node:crypto'
import {
  type Db,
  enqueueWork,
  SYSTEM_ACTOR,
  type WorkHandler,
  WorkRunner,
  withActorTx,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import { vi } from 'vitest'
import { enqueueFreeze } from '../intake/freeze'
import { scanHandler } from '../intake/scan'
import type { IntakeHarness, WorkOutcome } from '../intake/testing'
import { createWorkGate } from '../work-gate'
import { enqueueImport, type ImportRun, importParseHandler } from './parse'
import { snapshotOf } from './snapshot'

export { plantDisk, zipOf } from './fixture-disk'

/** The snapshot of a fictional old disk through the real `scan:freeze` and the import works. */

async function runOne(
  db: Db,
  workId: string,
  handlers: Partial<Record<string, WorkHandler>>,
): Promise<WorkOutcome> {
  const runner = new WorkRunner({
    db,
    role: 'worker',
    handlers: handlers as never,
    gate: createWorkGate(),
    pollMs: 20,
    leaseMs: 10_000,
    backoffMs: () => 60_000,
    maxAttempts: 3,
    stopTimeoutMs: 1_000,
  })
  runner.start()
  try {
    return await vi.waitFor(
      async () => {
        const { rows } = await db.execute<WorkOutcome & Record<string, unknown>>(sql`
          SELECT id, state, error_code, paused_reason, report, next_attempt_at::text
            FROM work_operations WHERE id = ${workId}::uuid`)
        const row = rows[0]
        if (!row) throw new Error(`no work ${workId}`)
        const done =
          ['succeeded', 'failed', 'cancelled'].includes(row.state) ||
          (row.state === 'retry_wait' && row.error_code !== null)
        if (!done) throw new Error(`work ${workId} is ${row.state}`)
        return row
      },
      { timeout: 30_000, interval: 50 },
    )
  } finally {
    await runner.stop()
  }
}

/** The snapshot of the harness's Yandex Disk on a date, through the real work. */
export async function freezeDisk(h: IntakeHarness, date: string): Promise<WorkOutcome> {
  const queued = await enqueueFreeze(h.db, { model: 'lora', source: 'Я.Диск', date })
  return runOne(h.db, queued.work.id, { scan: scanHandler(h.factory) })
}

const ACTOR = { actor: SYSTEM_ACTOR('test'), action: 'test.enqueue' }

/** Queues the pass or the dry run as the API does and runs it. */
export async function runImport(
  db: Db,
  modelId: string,
  mode: ImportRun,
): Promise<WorkOutcome & { created: boolean }> {
  const { work, created } = await withActorTx(
    db,
    { ...ACTOR, requestId: randomUUID() },
    async (tx) => {
      const snapshot = await snapshotOf(tx, modelId, null)
      if (!snapshot) throw new Error('no snapshot')
      return enqueueImport(tx, { modelId, mode, snapshot, nonce: randomUUID() })
    },
  )
  const outcome = await runOne(db, work.id, { import_parse: importParseHandler() })
  return { ...outcome, created }
}

/** Runs an import work the API queued. */
export function runQueued(db: Db, workId: string): Promise<WorkOutcome> {
  return runOne(db, workId, { import_parse: importParseHandler() })
}

/** The same pass again under another work key: what a retried or re-claimed work would do. */
export async function rerunParse(db: Db, modelId: string): Promise<WorkOutcome> {
  const { work } = await withActorTx(db, { ...ACTOR, requestId: randomUUID() }, async (tx) => {
    const snapshot = await snapshotOf(tx, modelId, null)
    if (!snapshot) throw new Error('no snapshot')
    return enqueueWork(tx, {
      modelId,
      kind: 'import_parse',
      workKey: `test:${randomUUID()}`,
      dataset: 'parse',
      scope: snapshot.id,
    })
  })
  return runOne(db, work.id, { import_parse: importParseHandler() })
}
