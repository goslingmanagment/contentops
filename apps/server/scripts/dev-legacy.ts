// «Разбор старого» on the dev stand (PLAN этап 3, fictional names only): a fake old Я.Диск of
// Лора in the shapes of the real one, its snapshot `scan:freeze` through the real work, the
// registry export, the dry run and the metadata pass — all in this process, against the
// database of `pnpm dev:server`:
//
//   DATABASE_URL=postgres://contentops_app:dev-app@127.0.0.1:54329/contentops \
//     pnpm --filter @contentops/server exec tsx scripts/dev-legacy.ts
//
// A repeat finds the same snapshot and the same pass. Never for a database with real content.
import { randomUUID } from 'node:crypto'
import {
  createDb,
  createPool,
  type Db,
  SYSTEM_ACTOR,
  type WorkHandler,
  WorkRunner,
  withActorTx,
} from '@contentops/db'
import { FIXTURE_DISK, FIXTURE_REGISTRY } from '@contentops/legacy/fixture'
import { createYandexDiskSource } from '@contentops/sources'
import { fakeBytes, startFakeYandexDisk } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { enqueueFreeze } from '../src/intake/freeze'
import { scanHandler } from '../src/intake/scan'
import { writeInputs } from '../src/legacy/inputs'
import { enqueueImport, importParseHandler } from '../src/legacy/parse'
import { snapshotOf } from '../src/legacy/snapshot'
import { plantDisk, zipOf } from '../src/legacy/fixture-disk'
import { createWorkGate } from '../src/work-gate'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('dev-legacy: set DATABASE_URL')
  process.exit(2)
}
const pool = createPool(url, { max: 4, applicationName: 'dev-legacy' })
const db = createDb(pool)
const ctx = (action: string) => ({ actor: SYSTEM_ACTOR('dev-legacy'), action, requestId: randomUUID() })

async function runUntilDone(id: string, handlers: Partial<Record<string, WorkHandler>>) {
  const runner = new WorkRunner({
    db,
    role: 'worker',
    handlers: handlers as never,
    gate: createWorkGate(),
    pollMs: 50,
  })
  runner.start()
  try {
    for (;;) {
      const { rows } = await db.execute<{ state: string; error_text: string | null }>(sql`
        SELECT state, error_text FROM work_operations WHERE id = ${id}::uuid`)
      const state = rows[0]?.state
      if (state === 'succeeded') return
      if (state === 'failed' || state === 'retry_wait') throw new Error(rows[0]?.error_text ?? state)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  } finally {
    await runner.stop()
  }
}

async function main(dbx: Db) {
  const { rows } = await dbx.execute<{ id: string; source: string; root: string }>(sql`
    SELECT m.id, s.id AS source, s.root_path AS root FROM models m
      JOIN sources s ON s.model_id = m.id AND s.kind = 'yandex_disk'
     WHERE m.code = 'lora'`)
  const lora = rows[0]
  if (!lora) throw new Error('no Я.Диск source of lora: bootstrap.example.json first')
  const fake = await startFakeYandexDisk()
  const root = lora.root.replace(/^disk:/, '').replace(/\/$/, '')
  plantDisk(fake.tree, root, FIXTURE_DISK, {
    '5. Sextings/sexting feb.zip': await zipOf({
      'feb/sexting_011_mesh_dress_14.02.25/1.jpg': fakeBytes(900, 'sxt-11-1'),
    }),
  })
  // The owner's switch «Скан по источнику» of the old disk, journaled like a click.
  await withActorTx(dbx, ctx('admin.updateIntegration'), (tx) =>
    tx.execute(sql`
      INSERT INTO policy_settings (model_id, key, value) VALUES (${lora.id}::uuid, 'ydisk.scan', 'true')
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = 'true'`),
  )
  const factory = () =>
    createYandexDiskSource({ token: fake.token, root: lora.root, apiBase: fake.url })
  try {
    const frozen = await enqueueFreeze(dbx, { model: 'lora', source: 'Я.Диск', date: '2026-11-02' })
    await runUntilDone(frozen.work.id, { scan: scanHandler(factory) })
    console.log(`dev-legacy: snapshot ${frozen.work.workKey}`)
  } finally {
    await fake.close()
  }
  await withActorTx(dbx, ctx('legacy.inputs'), (tx) =>
    writeInputs(tx, lora.id, null, { registry: FIXTURE_REGISTRY }),
  )
  for (const mode of ['plan', 'parse'] as const) {
    const { work } = await withActorTx(dbx, ctx(`legacy.${mode}`), async (tx) => {
      const snapshot = await snapshotOf(tx, lora.id, null)
      if (!snapshot) throw new Error('no snapshot')
      return enqueueImport(tx, { modelId: lora.id, mode, snapshot, nonce: 'dev-legacy' })
    })
    await runUntilDone(work.id, { import_parse: importParseHandler() })
    console.log(`dev-legacy: ${mode} ${work.id}`)
  }
}

try {
  await main(db)
} finally {
  await pool.end()
}
