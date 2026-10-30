import { IntegrationViewSchema } from '@contentops/contracts/api/responses'
import { ThresholdSchema } from '@contentops/contracts/domain/system'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { shaBytes } from './media/storage'
import { registerBlob } from './media/storage-ops'
import { tempFile } from './media/testing'
import { createCatalogItems } from './testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * PLAN 1а: the base scenario «всё выключено» — every switch off and no integration secret in
 * the environment. Steps are added as functions arrive (2а–2в, 4а: upload, accept, find,
 * download, put in the plan, mark by hand); the whole path passes when stage 4 closes.
 */

let server: TestServer
let owner: string

beforeAll(async () => {
  server = await testServer({ secrets: { ydisk: false, dropbox: false, hub: false } })
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
})
