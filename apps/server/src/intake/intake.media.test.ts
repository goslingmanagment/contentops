import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  SYSTEM_ACTOR,
  type values,
  type WorkHandler,
  WorkRunner,
  withActorTx,
} from '@contentops/db'
import { recordingRetry } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import type { Actor } from '../context'
import { createMediaEnv, type MediaEnv } from '../media/pipeline'
import { mediaHandlers } from '../media/roles'
import type { BlobStore } from '../media/storage'
import { tempStore } from '../media/testing'
import { acceptGroup } from './accept'
import { fetchHandler } from './fetch'
import { inboxGroup } from './inbox-view'
import { intakeMediaHandlers } from './media'
import { scanHandler } from './scan'
import { drain, type IntakeHarness, intakeHarness, LORA_ROOT, runWork, setSwitch } from './testing'

/**
 * The whole chain of SPEC §6.1 with the real tools (CI job `media`): a photo and a video in
 * the fake Dropbox of Lora → discovery → fetch → derivatives and master → «готово» → accept
 * issues LIFE-001 over the verified masters. Generated fixtures, no people.
 */

const fx = inject('fixtures')
let h: IntakeHarness
let store: BlobStore
let env: MediaEnv
const runners: WorkRunner[] = []

beforeAll(async () => {
  h = await intakeHarness()
  store = await tempStore('intake-media')
  env = await createMediaEnv({ db: h.db, store, lp: 4, owner: 'test:intake', log: () => {} })
  await setSwitch(h.db, 'dropbox.scan', h.modelId, true)
})
afterAll(async () => {
  await Promise.all(runners.map((runner) => runner.stop()))
  await h?.close()
})

function start(role: values.WorkRole): void {
  const handlers: Partial<Record<values.WorkKind, WorkHandler>> = {
    ...mediaHandlers(role, env),
    ...intakeMediaHandlers(role, env),
  }
  const runner = new WorkRunner({
    db: h.db,
    role,
    handlers,
    pollMs: 50,
    leaseMs: 30_000,
    limits: { encode: 1, image: 1 },
    owner: `${role}:test:${randomUUID().slice(0, 6)}`,
    maxAttempts: 2,
    backoffMs: () => 50,
  })
  runners.push(runner)
  runner.start()
}

describe('intake with the real media pipeline', () => {
  it('a photo and a video become «готово», then one object with verified masters', async () => {
    const dir = `${LORA_ROOT}/6. Life/Тест`
    h.dropbox.tree.addFile(`${dir}/photo.jpg`, await readFile(fx.files.rotatedJpeg))
    h.dropbox.tree.addFile(`${dir}/clip.mp4`, await readFile(fx.files.lowrate))
    await runWork(h.db, {
      modelId: h.modelId,
      kind: 'scan',
      scope: h.sources.dropbox.id,
      dataset: 'full',
      handlers: { scan: scanHandler(h.factory) },
    })
    const fetched = await drain(h.db, ['fetch'], {
      fetch: fetchHandler({
        factory: h.factory,
        store,
        fetchAheadGb: 25,
        retry: recordingRetry({ attempts: 2 }).policy,
      }),
    })
    expect(fetched.map((work) => work.state)).toEqual(['succeeded', 'succeeded'])

    start('worker-image')
    start('worker-video')
    const { rows: groups } = await h.db.execute<{ group_id: string }>(sql`
      SELECT DISTINCT group_id FROM inbox_drafts WHERE path LIKE ${`${dir}/%`}`)
    const groupId = groups[0]?.group_id as string
    const model = { id: h.modelId, code: 'lora', name: 'Лора' }
    await vi.waitFor(
      async () => {
        const group = await inboxGroup(h.db, model, groupId)
        if (group.state.kind !== 'ready') throw new Error(`group is ${JSON.stringify(group.state)}`)
      },
      { timeout: 280_000, interval: 500 },
    )
    const ready = await inboxGroup(h.db, model, groupId)
    // Our own preview replaces the source's picture once it is built.
    expect(ready.files.find((file) => file.media === 'photo')?.thumb.url).toMatch(
      /\/g\/.+\/thumb-640\.webp$/,
    )

    const { rows: owners } = await h.db.execute<{ id: string }>(
      sql`SELECT id FROM principals LIMIT 1`,
    )
    const actor: Actor = {
      type: 'person',
      id: owners[0]?.id as string,
      role: 'owner',
      models: ['lora'],
      name: 'Владелец',
      gender: 'm',
      sessionId: null,
      tokenId: null,
    }
    const result = await withActorTx(
      h.db,
      { actor: SYSTEM_ACTOR('test'), action: 'inbox.accept', requestId: randomUUID() },
      (tx) => acceptGroup(tx, model, actor, groupId, { as: 'default' }),
    )
    expect(result).toMatchObject({ item_id: 'LIFE-001', how: 'new' })
    const { rows: files } = await h.db.execute<{
      role: string
      media: string
      present: boolean
    }>(sql`
      SELECT m.role, a.media_kind AS media, b.state = 'present' AS present
        FROM content_items i
        JOIN item_memberships m ON m.model_id = i.model_id AND m.item_id = i.id
        JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
        JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
        JOIN blobs b ON b.sha256 = v.master_sha256
       WHERE i.model_id = ${h.modelId}::uuid AND i.type = 'LIFE' AND i.number = 1
       ORDER BY m.role`)
    expect(files).toEqual([
      { role: 'clip', media: 'video', present: true },
      { role: 'pic', media: 'image', present: true },
    ])
  })
})
