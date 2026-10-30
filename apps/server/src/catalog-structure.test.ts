import { ItemDetailSchema } from '@contentops/contracts/domain/item'
import { SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems } from './testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * The structure of the catalog (SPEC §4.1, §6.3, schema §3.2): a type change is a new number
 * with the files and the old ID as an alias; a removal is a tombstone that comes back with
 * its number; RAW batches merge (the lower number stays) and split. Both are refused while
 * promo points at the object.
 */

let server: TestServer
let owner: string

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  await createCatalogItems(server.db, 'lora', [
    {
      type: 'set',
      number: 69,
      title: 'Кружево у окна',
      tags: ['lace'],
      confirmed: ['title'],
      files: [{ role: 'raw' }, { role: 'raw' }, { role: 'ed', ordinal: 1 }],
    },
    {
      type: 'ppv',
      number: 73,
      title: 'Вечеринка',
      files: [{ role: 'master' }, { role: 'teaser' }],
    },
    { type: 'ppv', number: 74, title: 'Платье', files: [{ role: 'master' }] },
    { type: 'raw', number: 34, title: 'Съёмка 12.08', files: [{ role: 'raw' }, { role: 'raw' }] },
    {
      type: 'raw',
      number: 36,
      title: 'Съёмка 13.08',
      files: [{ role: 'raw' }, { role: 'raw', media: 'video' }, { role: 'raw' }],
    },
    { type: 'life', number: 191, title: 'Завтрак', files: [{ role: 'pic' }] },
    {
      type: 'promo',
      number: 1,
      title: 'Подборка',
      references: [{ item: 'PPV-073', handle: 'teaser' }],
    },
  ])
})
afterAll(() => server.close())

const get = (url: string) =>
  call(server.app, { method: 'GET', url: `/api/v1/lora${url}`, as: owner })
const page = async (id: string) => ItemDetailSchema.parse((await get(`/i/${id}`)).json())
const send = (
  method: 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  options: { ifMatch?: number; key?: string } = {},
) =>
  call(server.app, {
    method,
    url: `/api/v1/lora${url}`,
    as: owner,
    key: options.key ?? newKey(),
    ifMatch: options.ifMatch,
    body,
  })

describe('type change', () => {
  it('makes a new number, moves files, fields and tags, and keeps the old ID as an alias', async () => {
    const set = await page('SET-069')
    expect((await send('POST', '/i/SET-069:change-type', { type: 'life' })).statusCode).toBe(428)
    const response = await send(
      'POST',
      '/i/SET-069:change-type',
      { type: 'life' },
      {
        ifMatch: set.version,
      },
    )
    expect(response.statusCode).toBe(200)
    const { item_id: id } = response.json()
    expect(id).toBe('LIFE-192')
    const life = await page(id)
    expect(life.files.map((file) => file.key)).toEqual(['pic01', 'pic02', 'pic03'])
    expect(life.entry).toMatchObject({
      title: 'Кружево у окна',
      tags: ['lace'],
      aliases: ['SET-069'],
    })
    expect(life.markup.find((field) => field.field.key === 'title')?.status).toBe('confirmed')
    const old = await page('SET-069')
    expect(old.lifecycle).toMatchObject({ state: 'merged', into: 'LIFE-192' })
    expect((await get(`/resolve?q=${encodeURIComponent('сет 69')}`)).json()).toMatchObject({
      item_id: 'LIFE-192',
    })
    const search = await get(`/search?q=${encodeURIComponent('SET-069/raw01')}`)
    expect(search.json().groups.flatMap((group: { item_ids: string[] }) => group.item_ids)).toEqual(
      ['LIFE-192'],
    )
    const events = (
      await call(server.app, {
        method: 'GET',
        url: '/api/v1/lora/journal?item=LIFE-192',
        as: owner,
      })
    ).json().items
    expect(events[0]).toMatchObject({ action: 'objects.changeType', item_id: 'LIFE-192' })
  })

  it('refuses files without a place, the same type and an object in promo', async () => {
    const ppv = await page('PPV-074')
    const set = await send(
      'POST',
      '/i/PPV-074:change-type',
      { type: 'set' },
      { ifMatch: ppv.version },
    )
    expect(set.statusCode).toBe(400)
    const same = await send(
      'POST',
      '/i/PPV-074:change-type',
      { type: 'ppv' },
      { ifMatch: ppv.version },
    )
    expect(same.statusCode).toBe(400)
    const used = await page('PPV-073')
    const promo = await send(
      'POST',
      '/i/PPV-073:change-type',
      { type: 'custom' },
      {
        ifMatch: used.version,
      },
    )
    expect(promo.statusCode).toBe(422)
    expect(promo.json().code).toBe('item_in_use')
  })

  it('issues no number while legacy numbers are not checked (stage 3)', async () => {
    await createCatalogItems(server.db, 'ari', [
      { type: 'ppv', title: 'Без номера', files: [{ role: 'master' }] },
    ])
    await withActorTx(
      server.db,
      { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: 'legacy-not-checked' },
      (tx) =>
        tx.execute(sql`UPDATE id_counters SET legacy_reserved_at = NULL
                        WHERE model_id = (SELECT id FROM models WHERE code = 'ari')`),
    )
    const detail = ItemDetailSchema.parse(
      (await call(server.app, { method: 'GET', url: '/api/v1/ari/i/PPV-001', as: owner })).json(),
    )
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/ari/i/PPV-001:change-type',
      as: owner,
      key: newKey(),
      ifMatch: detail.version,
      body: { type: 'custom' },
    })
    expect(response.json().code).toBe('number_not_issued')
  })
})

describe('removal', () => {
  it('leaves a tombstone that comes back with its number', async () => {
    const life = await page('LIFE-191')
    const body = { confirm: true }
    expect((await send('DELETE', '/i/LIFE-191', body)).statusCode).toBe(428)
    const key = newKey()
    const removed = await send('DELETE', '/i/LIFE-191', body, { ifMatch: life.version, key })
    expect(removed.json()).toEqual({ ok: true })
    const again = await send('DELETE', '/i/LIFE-191', body, { ifMatch: life.version, key })
    expect(again.json()).toEqual({ ok: true })
    const index = (await get('/index')).json().items.map((entry: { id: string }) => entry.id)
    expect(index).not.toContain('LIFE-191')
    expect((await get('/deleted')).json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_id: 'LIFE-191', deleted_by: 'Дмитрий' }),
      ]),
    )
    expect((await page('LIFE-191')).lifecycle.state).toBe('deleted')
    const restored = await send('POST', '/i/LIFE-191:restore')
    expect(restored.statusCode).toBe(200)
    expect(ItemDetailSchema.parse(restored.json()).lifecycle.state).toBe('active')
    expect((await page('LIFE-191')).files.map((file) => file.key)).toEqual(['pic01'])
  })

  it('refuses an object in promo and never brings back a merged one', async () => {
    const used = await page('PPV-073')
    const removed = await send('DELETE', '/i/PPV-073', { confirm: true }, { ifMatch: used.version })
    expect(removed.json().code).toBe('item_in_use')
    expect((await send('POST', '/i/SET-069:restore')).statusCode).toBe(400)
    expect((await send('POST', '/i/PPV-074:restore')).statusCode).toBe(400)
  })
})

describe('raw batches', () => {
  it('merge keeps the lower number and the other ID and handles as aliases', async () => {
    const younger = await page('RAW-0036')
    const stale = await send('POST', '/i/RAW-0036:merge', { into: 'RAW-0034' }, { ifMatch: 99 })
    expect(stale.statusCode).toBe(412)
    const response = await send(
      'POST',
      '/i/RAW-0036:merge',
      { into: 'RAW-0034' },
      {
        ifMatch: younger.version,
      },
    )
    expect(response.json()).toEqual({ item_id: 'RAW-0034' })
    const survivor = await page('RAW-0034')
    expect(survivor.files.map((file) => file.key)).toEqual([
      'raw01',
      'raw02',
      'raw03',
      'raw04',
      'raw05',
    ])
    expect(survivor.entry.aliases).toContain('RAW-0036')
    expect(survivor.provenance).toEqual([
      expect.objectContaining({ relation: 'merged_from', item_id: 'RAW-0036', direction: 'out' }),
    ])
    expect((await page('RAW-0036')).lifecycle).toMatchObject({ state: 'merged', into: 'RAW-0034' })
    expect((await get(`/resolve?q=${encodeURIComponent('raw 36')}`)).json().item_id).toBe(
      'RAW-0034',
    )
    const deleted = (await get('/deleted')).json().items
    expect(deleted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_id: 'RAW-0036', merged_into: 'RAW-0034' }),
      ]),
    )
  })

  it('split gives the picked files a new number and keeps the rest', async () => {
    const response = await send('POST', '/i/RAW-0034:extract', { keys: ['raw04', 'raw05'] })
    expect(response.statusCode).toBe(201)
    const { item_id: id } = response.json()
    expect(id).toBe('RAW-0037')
    expect((await page(id)).files.map((file) => file.key)).toEqual(['raw01', 'raw02'])
    expect((await page(id)).provenance).toEqual([
      expect.objectContaining({
        relation: 'extracted_from',
        item_id: 'RAW-0034',
        direction: 'out',
      }),
    ])
    expect((await page('RAW-0034')).files.map((file) => file.key)).toEqual([
      'raw01',
      'raw02',
      'raw03',
    ])
    const all = await send('POST', '/i/RAW-0034:extract', { keys: ['raw01', 'raw02', 'raw03'] })
    expect(all.statusCode).toBe(400)
    expect((await send('POST', '/i/PPV-074:extract', { keys: ['master'] })).statusCode).toBe(400)
  })
})
