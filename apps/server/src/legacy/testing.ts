import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Db,
  enqueueWork,
  SYSTEM_ACTOR,
  type WorkHandler,
  WorkRunner,
  withActorTx,
} from '@contentops/db'
import type { LegacyListingEntry } from '@contentops/legacy'
import type { FakeTree } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { vi } from 'vitest'
import { enqueueFreeze } from '../intake/freeze'
import { scanHandler } from '../intake/scan'
import type { IntakeHarness, WorkOutcome } from '../intake/testing'
import { writeZip } from '../media/zip'
import { createWorkGate } from '../work-gate'
import { enqueueImport, type ImportMode, importParseHandler } from './parse'
import { snapshotOf } from './snapshot'

/**
 * A fictional old disk on the fake Yandex Disk (PLAN этап 3: fictional names in the shapes of
 * the real ones), its snapshot through the real `scan:freeze` and the import works.
 */

/** A stored ZIP of members with fixed bytes, as an archive of the old disk. */
export async function zipOf(members: Record<string, Buffer>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-zip-'))
  try {
    const files = await Promise.all(
      Object.entries(members).map(async ([name, bytes], n) => {
        const path = join(dir, String(n))
        await writeFile(path, bytes)
        return { name, path }
      }),
    )
    await writeZip(join(dir, 'out.zip'), files)
    return await readFile(join(dir, 'out.zip'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const relative = (path: string) => path.replace(/^disk:\//, '')

/**
 * Plants a listing under `root`: folders, files of their size (equal md5 of the listing — equal
 * bytes), upload and shot times; `bytes` replaces the content of a path (archives).
 */
export function plantDisk(
  tree: FakeTree,
  root: string,
  listing: readonly LegacyListingEntry[],
  bytes: Record<string, Buffer> = {},
): void {
  for (const entry of listing) {
    const path = `${root}/${relative(entry.path)}`
    if (entry.isDir) {
      tree.addFolder(path)
      continue
    }
    const given = bytes[relative(entry.path)]
    const size = entry.size ?? 1000
    const content = given ?? (entry.md5 ? Buffer.alloc(size, entry.md5) : size)
    tree.addFile(path, content, {
      ...(entry.createdAt ? { created: new Date(entry.createdAt) } : {}),
      ...(entry.shotAt ? { shotAt: new Date(entry.shotAt) } : {}),
    })
  }
}

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
  mode: ImportMode,
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
