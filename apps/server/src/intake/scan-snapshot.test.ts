import { randomUUID } from 'node:crypto'
import { SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { enqueueFreeze } from './freeze'
import { scanHandler } from './scan'
import {
  type IntakeHarness,
  intakeCounts,
  intakeHarness,
  LORA_ROOT,
  runWork,
  setSwitch,
} from './testing'

/**
 * SPEC §6.3, day one of stage 3: the owner turns the scan of the old disk on to take the
 * snapshot. Until the snapshot pins its revisions an ordinary scan — first window without a
 * cursor, so a full traversal — would make drafts and downloads of the whole old disk.
 */

let h: IntakeHarness

beforeAll(async () => {
  h = await intakeHarness()
  await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
  h.yandex.tree.addFile(`${LORA_ROOT}/1. PPV/[PPV-001]_oil/master.mp4`, 4000)
  h.yandex.tree.addFile(`${LORA_ROOT}/1. PPV/[PPV-001]_oil/cover.jpg`, 900)
})
afterAll(async () => {
  await h?.close()
})

const scan = (dataset: 'recent' | 'full') =>
  runWork(h.db, {
    modelId: h.modelId,
    kind: 'scan',
    scope: h.sources.yandex.id,
    dataset,
    handlers: { scan: scanHandler(h.factory) },
  })

async function holdSnapshot(workId: string, hold: boolean) {
  await withActorTx(
    h.db,
    { actor: SYSTEM_ACTOR('test'), action: 'test.hold', requestId: randomUUID() },
    (tx) =>
      tx.execute(sql`
        UPDATE work_operations
           SET state = 'retry_wait',
               next_attempt_at = CASE WHEN ${hold} THEN now() + interval '1 hour' ELSE now() END
         WHERE id = ${workId}::uuid`),
  )
}

describe('an ordinary scan and the snapshot of its source', () => {
  it('waits while the snapshot is queued: no objects, groups or drafts', async () => {
    const queued = await enqueueFreeze(h.db, {
      model: 'lora',
      source: 'Я.Диск',
      date: '2026-11-02',
    })
    // The snapshot is in the queue (here: retrying later), the scan goes first.
    await holdSnapshot(queued.work.id, true)
    for (const dataset of ['recent', 'full'] as const) {
      const early = await scan(dataset)
      expect(early.state).toBe('succeeded')
      expect(early.report).toMatchObject({
        mode: dataset,
        cursor: null,
        files: 0,
        drafts: 0,
        waiting_for_snapshot: 'scan:freeze:2026-11-02',
      })
    }
    expect(await intakeCounts(h.db)).toMatchObject({ objects: 0, groups: 0, drafts: 0 })

    await holdSnapshot(queued.work.id, false)
    const snapshot = await runWork(h.db, {
      modelId: h.modelId,
      kind: 'scan',
      workId: queued.work.id,
      handlers: { scan: scanHandler(h.factory) },
    })
    expect(snapshot.state).toBe('succeeded')
  })

  it('after the snapshot the pinned files stay the import’s; a new file is a draft', async () => {
    const after = await scan('recent')
    expect(after.report).toMatchObject({ files: 2, drafts: 0 })
    expect(after.report?.waiting_for_snapshot).toBeUndefined()
    expect(await intakeCounts(h.db)).toMatchObject({ groups: 0, drafts: 0 })

    h.yandex.tree.addFile(`${LORA_ROOT}/new/clip.mp4`, 3000)
    const later = await scan('full')
    expect(later.report).toMatchObject({ files: 3, drafts: 1 })
  })
})
