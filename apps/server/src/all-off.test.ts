import { randomBytes } from 'node:crypto'
import { IntegrationViewSchema } from '@contentops/contracts/api/responses'
import { ThresholdSchema } from '@contentops/contracts/domain/system'
import { WorkRunner } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMediaEnv } from './media/pipeline'
import { shaBytes } from './media/storage'
import { registerBlob } from './media/storage-ops'
import { systemTx, tempFile } from './media/testing'
import { exportHandler } from './media/work/export'
import { createCatalogItems } from './testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'
import { tusUpload } from './testing/tus'

/**
 * PLAN 1а: the base scenario «всё выключено» — every switch off and no integration secret in
 * the environment. Steps are added as functions arrive (2а–2в, 4а, 4в: upload, accept, find,
 * download, put in the plan, mark by hand, hand promo over); the whole path passes when
 * stage 4 closes.
 */

let server: TestServer
let owner: string

beforeAll(async () => {
  server = await testServer({ secrets: { hub: false } })
})
afterAll(() => server.close())

describe('«всё выключено»', () => {
  it('starts green without secrets', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('signs in', async () => {
    owner = await signIn(server.app, OWNER.login, OWNER.password)
    expect(owner).toBeTruthy()
  })

  it('shows every integration off or not set up, none working', async () => {
    const response = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/integrations',
      as: owner,
    })
    expect(response.statusCode).toBe(200)
    const items = response.json().items.map((item: unknown) => IntegrationViewSchema.parse(item))
    const states = Object.fromEntries(
      items.map((item: { id: string; state: string }) => [item.id, item.state]),
    )
    expect(states).toMatchObject({
      'ydisk.lora': 'unset',
      'hub.lora-1': 'unset',
      ai: 'unset',
      fyper: 'off',
      agents: 'off',
    })
    expect(Object.values(states)).not.toContain('working')
  })

  it('opens the settings: people, models, thresholds without values', async () => {
    for (const url of ['/api/v1/admin/people', '/api/v1/admin/models', '/api/v1/admin/agents']) {
      expect((await call(server.app, { method: 'GET', url, as: owner })).statusCode).toBe(200)
    }
    const thresholds = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/thresholds',
      as: owner,
    })
    const values = thresholds.json().items.map((item: unknown) => ThresholdSchema.parse(item).value)
    expect(values.every((value: number | null) => value === null)).toBe(true)
  })

  it('changes the week norm', async () => {
    const url = '/api/v1/lora/accounts/lora-of/week-norm'
    const norm = await call(server.app, { method: 'GET', url, as: owner })
    const { account: _account, version, ...body } = norm.json()
    const response = await call(server.app, {
      method: 'PUT',
      url,
      as: owner,
      key: newKey(),
      ifMatch: version,
      body: { ...body, release: { every_weeks: 2, weekday: 3, time: '20:00' } },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().version).toBe(version + 1)
  })

  it('finds an object: resolve, search and the object page', async () => {
    // Until acceptance (2в) objects come from the fixture factory, as acceptance leaves them.
    await createCatalogItems(server.db, 'lora', [
      {
        type: 'ppv',
        number: 73,
        title: 'Вечеринка, блёстки, диван',
        tags: ['dance'],
        files: [{ role: 'master' }, { role: 'teaser' }],
      },
    ])
    const resolve = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/resolve?q=${encodeURIComponent('ппв 73')}`,
      as: owner,
    })
    expect(resolve.json().item_id).toBe('PPV-073')
    const search = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/search?q=${encodeURIComponent('вечеринка')}`,
      as: owner,
    })
    expect(search.json().groups).toEqual([{ type: 'ppv', item_ids: ['PPV-073'], total: 1 }])
    const index = await call(server.app, { method: 'GET', url: '/api/v1/lora/index', as: owner })
    expect(index.json().items.map((entry: { id: string }) => entry.id)).toEqual(['PPV-073'])
    const page = await call(server.app, { method: 'GET', url: '/api/v1/lora/i/PPV-073', as: owner })
    expect(page.statusCode).toBe(200)
    expect(
      page
        .json()
        .pages.every((entry: { summary: { word: string } }) => entry.summary.word === 'не видели'),
    ).toBe(true)
  })

  it('downloads a file of the catalog: the receipt is sealed, nginx sends the bytes', async () => {
    const file = await tempFile('bytes of a fixture master', 'master.mp4')
    await registerBlob(server.db, server.store, {
      file: file.path,
      sha256: file.sha256,
      ext: 'mp4',
      mediaKind: 'video',
      owner: 'worker:test:1',
    })
    await createCatalogItems(server.db, 'lora', [
      {
        type: 'ppv',
        number: 900,
        title: 'Скачать без интеграций',
        files: [{ role: 'master', sha256: [shaBytes(file.sha256)] }],
      },
    ])
    const answer = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/i/PPV-900/downloads',
      as: owner,
      key: newKey(),
      body: { kind: 'master', strip_metadata: false, account: null },
    })
    expect(answer.statusCode).toBe(200)
    expect(answer.json()).toMatchObject({
      kind: 'ready',
      file_name: expect.stringMatching(/^PPV-900_skachat-integratsii_master__5m00s\.mp4$/),
    })
    const bytes = await call(server.app, {
      method: 'GET',
      url: answer.json().download_url,
      as: owner,
    })
    expect(bytes.statusCode).toBe(200)
    expect(bytes.headers['x-accel-redirect']).toMatch(/^\/_accel\/blobs\/sha256\//)
    expect(bytes.headers['content-disposition']).toContain('PPV-900_skachat-integratsii_master')
  })

  it('hands a promo collection over: link, prepare, ZIP, «Передано»', async () => {
    const contractor = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/models/lora/contractors',
      as: owner,
      key: newKey(),
      body: { name: 'Подрядчик', channel: 'reddit', contact: null, format: 'master' },
    })
    expect(contractor.statusCode).toBe(201)
    const collection = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/promo/collections:add',
      as: owner,
      key: newKey(),
      body: {
        channel: 'reddit',
        collection: 'new',
        title: 'Без интеграций',
        members: [{ item_id: 'PPV-900', file_key: 'master' }],
      },
    })
    expect(collection.json()).toMatchObject({ id: 'PRM-001', video_count: 1 })
    const started = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/promo/collections/PRM-001/handoffs',
      as: owner,
      key: newKey(),
      body: {
        contractor_id: contractor.json().id,
        strip_metadata: false,
        exclude_already_handed: true,
        members: null,
      },
    })
    expect(started.statusCode).toBe(202)
    const env = await createMediaEnv({
      db: server.db,
      store: server.store,
      lp: 1,
      owner: 'worker:all-off',
      log: () => {},
      versions: {
        ffmpeg: 'n8.1.2-test',
        ffprobe: 'n8.1.2-test',
        svtav1: 'v4.2.0-test',
        libvips: '8.16.1',
        sharp: '0.34.2',
        libheif: null,
        libde265: null,
        libwebp: null,
        phash: 'sharp-phash@2.2.0',
      },
      activate: false,
    })
    const runner = new WorkRunner({
      db: server.db,
      role: 'worker',
      handlers: { export: exportHandler(env) },
      pollMs: 20,
    })
    runner.start()
    const handoff = await vi
      .waitFor(
        async () => {
          const view = await call(server.app, {
            method: 'GET',
            url: '/api/v1/lora/promo/collections/PRM-001',
            as: owner,
          })
          const found = view.json().handoffs[0]
          if (found?.state !== 'prepared') throw new Error(found?.state)
          return found
        },
        { timeout: 10_000, interval: 50 },
      )
      .finally(() => runner.stop())
    const zip = await call(server.app, { method: 'GET', url: handoff.zip_url, as: owner })
    expect(zip.statusCode).toBe(200)
    const sent = await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/promo/collections/PRM-001/handoffs/${handoff.id}:mark-sent`,
      as: owner,
      key: newKey(),
    })
    expect(sent.json()).toMatchObject({ state: 'sent', status: { word: 'передано' } })
  })

  it('uploads a photo from the web and accepts it: a draft in «Приехало», then SET-001', async () => {
    const bytes = randomBytes(12_000)
    const uploadId = await tusUpload(server.app, {
      model: 'lora',
      as: owner,
      name: 'frame.jpg',
      bytes,
    })
    const uploaded = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/uploads',
      as: owner,
      key: newKey(),
      body: {
        kind: 'other',
        target: null,
        type: 'set',
        files: [
          { upload_id: uploadId, file_name: 'frame.jpg', size_bytes: bytes.length, media: 'photo' },
        ],
      },
    })
    expect(uploaded.statusCode).toBe(201)
    expect(uploaded.json()).toMatchObject({ placed: 'inbox', item_id: null, decision: null })
    const group = uploaded.json().group_id as string
    // What `derive_image` leaves (media works run in the image, `*.media.test.ts`): the
    // uploaded photo, decoded whole, is its own verified master.
    await systemTx(server.db, (tx) =>
      tx.execute(sql`
        UPDATE inbox_drafts
           SET master_sha256 = source_sha256, master_is_source = true,
               master_verified_at = now(), state = 'ready', ready_at = now()
         WHERE group_id = ${group}::uuid`),
    )
    const accepted = await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/groups/${group}:accept`,
      as: owner,
      key: newKey(),
      body: { as: 'default' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({ item_id: 'SET-001', how: 'new' })
  })

  it('puts an object into the plan and marks it by hand: Hub is off, the KM confirms', async () => {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
    const created = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/plan/rows',
      as: owner,
      key: newKey(),
      body: {
        rows: [
          {
            item_id: 'PPV-073',
            account: 'lora-1',
            surface: 'wall',
            date: today,
            time: null,
            fyp_version: null,
            assignee: null,
            note: null,
            requires_new_upload: false,
            awaiting_montage: null,
            marked: null,
          },
        ],
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    const [row] = created.json().rows
    expect(row).toMatchObject({ mark_button: 'mark_confirm', verdict: { word: 'в плане' } })
    const confirmed = await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/plan/rows/${row.id}:mark-confirm`,
      as: owner,
      key: newKey(),
      body: { stated_occurred_at: null },
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json().verdict).toMatchObject({
      sign: 'done',
      word: 'подтверждено',
      detail: 'вручную, Дмитрий',
    })
    const page = await call(server.app, { method: 'GET', url: '/api/v1/lora/i/PPV-073', as: owner })
    const lora1 = page.json().pages.find((entry: { account: string }) => entry.account === 'lora-1')
    expect(lora1.summary).toMatchObject({ word: 'подтверждено', placed_on: ['wall'] })
  })
})
