import { createHash, randomUUID } from 'node:crypto'
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
import { createLogger } from '../logger'
import { createMediaEnv, type MediaEnv } from '../media/pipeline'
import { mediaHandlers } from '../media/roles'
import type { BlobStore } from '../media/storage'
import { tempStore } from '../media/testing'
import { buildServer } from '../server'
import { call, newKey, signIn } from '../testing/server'
import { tusUpload } from '../testing/tus'
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
const started = new Set<values.WorkRole>()

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
  if (started.has(role)) return
  started.add(role)
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
    // The library cover of each file: an active thumbnail bound to its master (photo included);
    // the clip's version knows its length.
    const { rows: covers } = await h.db.execute<{
      role: string
      cover: boolean
      length: boolean
    }>(sql`
      SELECT m.role, c.thumb640_generation_id IS NOT NULL AS cover, v.duration_ms IS NOT NULL AS length
        FROM content_items i
        JOIN item_memberships m ON m.model_id = i.model_id AND m.item_id = i.id
        JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
        JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
        LEFT JOIN LATERAL (
          SELECT g.id AS thumb640_generation_id FROM rendition_generations g
           WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb640' AND g.is_active
             AND g.state = 'ready' LIMIT 1) c ON true
       WHERE i.model_id = ${h.modelId}::uuid AND i.type = 'LIFE' AND i.number = 1
       ORDER BY m.role`)
    expect(covers).toEqual([
      { role: 'clip', cover: true, length: true },
      { role: 'pic', cover: true, length: false },
    ])
  })

  it('a web upload «Другое» (photo and video) becomes «готово» from its blob, then an object', async () => {
    const app = buildServer({
      db: h.db,
      publicUrl: 'http://localhost:5173',
      secrets: { hub: false },
      sourceEnv: {},
      logger: createLogger({ level: 'silent' }),
      storage: store.roots,
    })
    await app.ready()
    try {
      const owner = await signIn(app, 'owner', 'owner-password')
      // Other bytes than the first case's: those are accepted already and would be aliases.
      const photo = await readFile(fx.files.smallPng)
      const clip = await readFile(fx.files.av1)
      const files = []
      for (const [name, bytes, media] of [
        ['photo.png', photo, 'photo'],
        ['clip.mp4', clip, 'video'],
      ] as const) {
        const uploadId = await tusUpload(app, { model: 'lora', as: owner, name, bytes })
        files.push({ upload_id: uploadId, file_name: name, size_bytes: bytes.length, media })
      }
      const answer = await call(app, {
        method: 'POST',
        url: '/api/v1/lora/uploads',
        as: owner,
        key: newKey(),
        body: { kind: 'other', target: null, type: 'life', files },
      })
      expect(answer.json()).toMatchObject({ placed: 'inbox', decision: null })
      const groupId = answer.json().group_id as string

      start('worker-image')
      start('worker-video')
      const model = { id: h.modelId, code: 'lora', name: 'Лора' }
      await vi.waitFor(
        async () => {
          const group = await inboxGroup(h.db, model, groupId)
          if (group.state.kind !== 'ready') throw new Error(JSON.stringify(group.state))
        },
        { timeout: 280_000, interval: 500 },
      )
      const accepted = await call(app, {
        method: 'POST',
        url: `/api/v1/lora/inbox/groups/${groupId}:accept`,
        as: owner,
        key: newKey(),
        body: { as: 'default' },
      })
      expect(accepted.json()).toMatchObject({
        item_id: expect.stringMatching(/^LIFE-/),
        how: 'new',
      })
      // Nothing of the upload went through `staging/`: the media works read its blob.
      expect(await store.staged(createHash('sha256').update(clip).digest('hex'))).toBeNull()
    } finally {
      await app.close()
    }
  })
})
