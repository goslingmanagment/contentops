import { type ItemDetail, ItemDetailSchema } from '@contentops/contracts/domain/item'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems, linkCatalogItems } from './testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * Changing the catalog (PLAN 2а, SPEC §5, §11.2): markup fields by their own versions with
 * confirmation of exactly what was seen, flags and files by the object's version, provenance
 * with the cycle check, batches «по каждой записи», tags of the dictionary. Every command:
 * the happy path, 404 inside the model, 428/412 where a version is due, an idempotent
 * repeat, and its journal row on the object.
 */

let server: TestServer
let owner: string

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  await createCatalogItems(server.db, 'lora', [
    { type: 'raw', number: 34, title: 'Съёмка', files: [{ role: 'raw' }, { role: 'raw' }] },
    { type: 'custom', number: 181, title: 'нейлон', files: [{ role: 'master' }] },
    {
      type: 'ppv',
      number: 73,
      title: 'Вечеринка',
      description: 'Танцует',
      tags: ['dance'],
      confirmed: ['title'],
      files: [
        { role: 'master', durationS: 600, chronology: [{ atS: 0, text: 'начало' }] },
        { role: 'teaser' },
        { role: 'pic' },
        { role: 'pic' },
        { role: 'pic' },
      ],
    },
    { type: 'ppv', number: 74, title: 'Платье', files: [{ role: 'master' }] },
    { type: 'set', number: 69, title: 'Кружево', files: [{ role: 'raw' }, { role: 'raw' }] },
    { type: 'life', number: 191, title: 'Завтрак', files: [{ role: 'pic' }, { role: 'pic' }] },
  ])
  await linkCatalogItems(server.db, 'lora', [
    { child: 'PPV-073', parent: 'CUS-181', relation: 'ppv_from_custom', suggested: true },
  ])
})
afterAll(() => server.close())

const page = async (id: string): Promise<ItemDetail> =>
  ItemDetailSchema.parse(
    (await call(server.app, { method: 'GET', url: `/api/v1/lora/i/${id}`, as: owner })).json(),
  )

const field = (detail: ItemDetail, key: string) =>
  detail.markup.find((candidate) => candidate.field.key === key)

function send(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  options: { ifMatch?: number; key?: string } = {},
) {
  return call(server.app, {
    method,
    url: `/api/v1/lora${url}`,
    as: owner,
    key: options.key ?? newKey(),
    ifMatch: options.ifMatch,
    body,
  })
}

async function itemEvents(id: string) {
  const response = await call(server.app, {
    method: 'GET',
    url: `/api/v1/lora/journal?item=${id}`,
    as: owner,
  })
  return response.json().items as { action: string; item_id: string; phrase: string }[]
}

describe('markup fields', () => {
  it('saves a field by its version and confirms only that field', async () => {
    const before = await page('PPV-073')
    const description = field(before, 'description')
    expect(description?.status).toBe('draft_import')
    const response = await send(
      'PATCH',
      '/i/PPV-073/fields/title',
      { key: 'title', value: 'Вечеринка, блёстки' },
      { ifMatch: field(before, 'title')?.version },
    )
    expect(response.statusCode).toBe(200)
    const after = ItemDetailSchema.parse(response.json())
    expect(field(after, 'title')).toMatchObject({
      field: { value: 'Вечеринка, блёстки' },
      status: 'confirmed',
      version: (field(before, 'title')?.version ?? 0) + 1,
      confirmed_by: 'Дмитрий',
    })
    expect(field(after, 'description')).toMatchObject({
      status: 'draft_import',
      version: description?.version,
    })
    expect(after.entry.title).toBe('Вечеринка, блёстки')
    const events = await itemEvents('PPV-073')
    expect(events[0]).toMatchObject({
      action: 'objects.updateField',
      item_id: 'PPV-073',
      phrase: 'Дмитрий изменил название PPV-073',
    })
  })

  it('refuses without a version (428) and with a stale one (412 with details)', async () => {
    const body = { key: 'description', value: 'Новое' }
    expect((await send('PATCH', '/i/PPV-073/fields/description', body)).statusCode).toBe(428)
    const stale = await send(
      'PATCH',
      '/i/PPV-073/fields/title',
      { key: 'title', value: 'X' },
      {
        ifMatch: 1,
      },
    )
    expect(stale.statusCode).toBe(412)
    expect(stale.json().details).toMatchObject({
      changed_by: 'Дмитрий',
      field: 'Название',
      current_value: { key: 'title', value: 'Вечеринка, блёстки' },
    })
  })

  it('gives one 200 and one 412 to two people saving the same version', async () => {
    const version = field(await page('PPV-074'), 'title')?.version
    const [left, right] = await Promise.all(
      ['Первое', 'Второе'].map((value) =>
        send('PATCH', '/i/PPV-074/fields/title', { key: 'title', value }, { ifMatch: version }),
      ),
    )
    expect([left?.statusCode, right?.statusCode].sort()).toEqual([200, 412])
  })

  it('replays a repeat with the same key and writes one journal row', async () => {
    const key = newKey()
    const version = field(await page('PPV-073'), 'title_en')?.version
    const body = { key: 'title_en', value: 'glitter-party' }
    const first = await send('PATCH', '/i/PPV-073/fields/title_en', body, { ifMatch: version, key })
    const again = await send('PATCH', '/i/PPV-073/fields/title_en', body, { ifMatch: version, key })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    const rows = (await itemEvents('PPV-073')).filter((event) =>
      event.phrase.includes('английское название'),
    )
    expect(rows).toHaveLength(1)
  })

  it('writes tags, chronology and selling texts', async () => {
    const detail = await page('PPV-073')
    const tags = await send(
      'PATCH',
      '/i/PPV-073/fields/tags',
      { key: 'tags', value: ['dance', 'чулки', 'свой тег'] },
      { ifMatch: field(detail, 'tags')?.version },
    )
    expect(field(ItemDetailSchema.parse(tags.json()), 'tags')?.field.value).toEqual([
      'dance',
      'stockings',
      'свой тег',
    ])
    const timeline = await send(
      'PATCH',
      '/i/PPV-073/fields/timeline',
      {
        key: 'timeline',
        value: [
          { start_s: 0, label: 'привет' },
          { start_s: 90, label: 'танец' },
        ],
      },
      { ifMatch: field(detail, 'timeline')?.version },
    )
    expect(field(ItemDetailSchema.parse(timeline.json()), 'timeline')).toMatchObject({
      status: 'confirmed',
      field: {
        value: [
          { start_s: 0, label: 'привет' },
          { start_s: 90, label: 'танец' },
        ],
      },
    })
    const texts = await send(
      'PATCH',
      '/i/PPV-073/fields/platform_texts',
      { key: 'platform_texts', value: { wall: 'Party', message: 'See the end?' } },
      { ifMatch: field(detail, 'platform_texts')?.version },
    )
    expect(field(ItemDetailSchema.parse(texts.json()), 'platform_texts')?.status).toBe('confirmed')
    const search = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/search?q=${encodeURIComponent('танец')}`,
      as: owner,
    })
    expect(search.json().timeline).toEqual([{ item_id: 'PPV-073', t_s: 90, label: 'танец' }])
  })

  it('refuses a field the object has not and a wrong body', async () => {
    const body = { key: 'timeline', value: [] }
    expect(
      (await send('PATCH', '/i/SET-069/fields/timeline', body, { ifMatch: 1 })).statusCode,
    ).toBe(400)
    const mismatch = await send(
      'PATCH',
      '/i/PPV-073/fields/title',
      { key: 'description', value: 'x' },
      {
        ifMatch: 1,
      },
    )
    expect(mismatch.statusCode).toBe(400)
    const missing = await send(
      'PATCH',
      '/i/PPV-999/fields/title',
      { key: 'title', value: 'x' },
      {
        ifMatch: 1,
      },
    )
    expect(missing.statusCode).toBe(404)
  })

  it('«Подтвердить всю разметку» confirms exactly the versions seen', async () => {
    const seen = await page('PPV-073')
    const description = field(seen, 'description')
    const response = await send('POST', '/i/PPV-073/markup:confirm', {
      fields: [
        { key: 'description', version: description?.version },
        { key: 'title_en', version: 1 },
      ],
    })
    expect(response.statusCode).toBe(200)
    const after = ItemDetailSchema.parse(response.json())
    expect(field(after, 'description')).toMatchObject({
      status: 'confirmed',
      version: description?.version,
    })
    expect(after.entry.markup).toBe('confirmed')
    const review = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/markup/review',
      as: owner,
    })
    expect(review.json().items.map((item: { item_id: string }) => item.item_id)).not.toContain(
      'PPV-073',
    )
  })

  it('a value that came after the look stays a draft', async () => {
    const seen = await page('CUS-181')
    await createCatalogItems(server.db, 'lora', [
      { type: 'sexting', number: 5, title: 'Переписка' },
    ])
    const response = await send('POST', '/i/SXT-005/markup:confirm', {
      fields: [{ key: 'title', version: 99 }],
    })
    expect(field(ItemDetailSchema.parse(response.json()), 'title')?.status).toBe('draft_import')
    expect(seen.entry.id).toBe('CUS-181')
  })
})

describe('flags', () => {
  it('sets «второй человек» and «имя фана» by the object version', async () => {
    const detail = await page('CUS-181')
    expect((await send('PATCH', '/i/CUS-181/flags', { second_person: true })).statusCode).toBe(428)
    expect(
      (await send('PATCH', '/i/CUS-181/flags', { second_person: true }, { ifMatch: 999 }))
        .statusCode,
    ).toBe(412)
    const response = await send(
      'PATCH',
      '/i/CUS-181/flags',
      { second_person: true, fan_name: 'yes' },
      { ifMatch: detail.version },
    )
    expect(response.statusCode).toBe(200)
    expect(response.headers.etag).toBe(`"${detail.version + 1}"`)
    expect(ItemDetailSchema.parse(response.json()).entry).toMatchObject({
      second_person: true,
      fan_name: 'yes',
    })
    const ppv = await page('PPV-074')
    const wrong = await send(
      'PATCH',
      '/i/PPV-074/flags',
      { fan_name: 'yes' },
      { ifMatch: ppv.version },
    )
    expect(wrong.statusCode).toBe(400)
  })
})

describe('provenance', () => {
  it('adds, confirms and removes a link, on both objects', async () => {
    const added = await send('POST', '/i/PPV-074/links', {
      relation: 'made_from',
      direction: 'out',
      item_id: 'RAW-0034',
    })
    expect(added.statusCode).toBe(201)
    expect(ItemDetailSchema.parse(added.json()).provenance).toEqual([
      expect.objectContaining({ item_id: 'RAW-0034', direction: 'out', confirmed: true }),
    ])
    const raw = await page('RAW-0034')
    expect(raw.provenance).toEqual([
      expect.objectContaining({ item_id: 'PPV-074', direction: 'in' }),
    ])
    expect((await itemEvents('RAW-0034'))[0]?.action).toBe('objects.addLink')

    const suggested = (await page('PPV-073')).provenance.find((link) => link.item_id === 'CUS-181')
    expect(suggested?.confirmed).toBe(false)
    const confirmed = await send('POST', `/i/PPV-073/links/${suggested?.id}:confirm`)
    expect(confirmed.statusCode).toBe(200)
    expect(ItemDetailSchema.parse(confirmed.json()).provenance[0]?.confirmed).toBe(true)

    const link = ItemDetailSchema.parse(added.json()).provenance[0]
    const removed = await send('DELETE', `/i/RAW-0034/links/${link?.id}`)
    expect(ItemDetailSchema.parse(removed.json()).provenance).toEqual([])
    expect((await send('DELETE', `/i/RAW-0034/links/${link?.id}`)).statusCode).toBe(404)
  })

  it('refuses a cycle, a repeat and a link to itself', async () => {
    const body = { relation: 'made_from', direction: 'out', item_id: 'PPV-073' }
    expect((await send('POST', '/i/CUS-181/links', body)).statusCode).toBe(400)
    const repeat = { relation: 'ppv_from_custom', direction: 'out', item_id: 'CUS-181' }
    expect((await send('POST', '/i/PPV-073/links', repeat)).statusCode).toBe(400)
    const self = { relation: 'made_from', direction: 'out', item_id: 'PPV-073' }
    expect((await send('POST', '/i/PPV-073/links', self)).statusCode).toBe(400)
    expect((await send('POST', '/i/PPV-999/links', self)).statusCode).toBe(404)
  })

  it('two opposite links at once: one wins, the other closes no circle', async () => {
    const [left, right] = await Promise.all([
      send('POST', '/i/SET-069/links', {
        relation: 'made_from',
        direction: 'out',
        item_id: 'LIFE-191',
      }),
      send('POST', '/i/LIFE-191/links', {
        relation: 'made_from',
        direction: 'out',
        item_id: 'SET-069',
      }),
    ])
    expect([left?.statusCode, right?.statusCode].sort()).toEqual([201, 400])
  })
})

describe('files', () => {
  it('reorders by the object version', async () => {
    const detail = await page('PPV-073')
    expect((await send('POST', '/i/PPV-073/files:reorder', { keys: ['pic03'] })).statusCode).toBe(
      428,
    )
    const response = await send(
      'POST',
      '/i/PPV-073/files:reorder',
      { keys: ['pic03', 'pic01'] },
      { ifMatch: detail.version },
    )
    expect(response.statusCode).toBe(200)
    expect(ItemDetailSchema.parse(response.json()).files.map((file) => file.key)).toEqual([
      'pic03',
      'pic01',
      'master',
      'teaser',
      'pic02',
    ])
    const unknown = await send(
      'POST',
      '/i/PPV-073/files:reorder',
      { keys: ['pic09'] },
      {
        ifMatch: detail.version + 1,
      },
    )
    expect(unknown.statusCode).toBe(400)
  })

  it('picks set frames and assigns life frames', async () => {
    const picked = await send('POST', '/i/SET-069/files:pick', { keys: ['raw02'], selected: true })
    expect(ItemDetailSchema.parse(picked.json()).entry.selected_count).toBe(1)
    const assigned = await send('POST', '/i/LIFE-191/files:assign', {
      keys: ['pic01', 'pic02'],
      assignment: 'both',
    })
    expect(ItemDetailSchema.parse(assigned.json()).entry).toMatchObject({
      life_chat_count: 2,
      life_feed_count: 2,
      life_unassigned: 0,
    })
    expect(
      (await send('POST', '/i/PPV-073/files:pick', { keys: ['pic01'], selected: true })).statusCode,
    ).toBe(400)
  })

  it('removes files but never the master, and the handle stays taken', async () => {
    const detail = await page('PPV-073')
    const master = await send(
      'POST',
      '/i/PPV-073/files:remove',
      { keys: ['master'] },
      {
        ifMatch: detail.version,
      },
    )
    expect(master.statusCode).toBe(400)
    const response = await send(
      'POST',
      '/i/PPV-073/files:remove',
      { keys: ['pic02'] },
      {
        ifMatch: detail.version,
      },
    )
    expect(response.statusCode).toBe(200)
    expect(ItemDetailSchema.parse(response.json()).files.map((file) => file.key)).not.toContain(
      'pic02',
    )
  })

  it('sets the purpose of raw footage', async () => {
    const detail = await page('RAW-0034')
    const response = await send(
      'PATCH',
      '/i/RAW-0034/purpose',
      { purpose: 'mailing' },
      {
        ifMatch: detail.version,
      },
    )
    expect(ItemDetailSchema.parse(response.json()).entry.raw_purpose).toBe('mailing')
    const ppv = await page('PPV-074')
    expect(
      (await send('PATCH', '/i/PPV-074/purpose', { purpose: 'fyp' }, { ifMatch: ppv.version }))
        .statusCode,
    ).toBe(400)
  })
})

describe('batches', () => {
  it('tags several objects with a result per object', async () => {
    const response = await send('POST', '/items:tags', {
      items: ['PPV-074', 'SET-069', 'PPV-999'],
      add: ['lace'],
      remove: [],
    })
    expect(response.json().results).toEqual([
      { id: 'PPV-074', ok: true, code: null },
      { id: 'SET-069', ok: true, code: null },
      { id: 'PPV-999', ok: false, code: 'not_found' },
    ])
    expect((await page('SET-069')).entry.tags).toContain('lace')
    expect((await itemEvents('SET-069'))[0]?.action).toBe('objectBatch.tags')
    await send('POST', '/items:tags', { items: ['SET-069'], add: [], remove: ['lace'] })
    expect((await page('SET-069')).entry.tags).not.toContain('lace')
  })

  it('marks «второй человек» on several objects', async () => {
    const response = await send('POST', '/items:second-person', {
      items: ['PPV-074', 'LIFE-191'],
      second_person: true,
      cancel_onlyfans_rows: false,
    })
    expect(response.json().results.every((result: { ok: boolean }) => result.ok)).toBe(true)
    expect((await page('LIFE-191')).entry.second_person).toBe(true)
  })
})

describe('tag dictionary', () => {
  const tags = async () =>
    (await call(server.app, { method: 'GET', url: '/api/v1/admin/tags', as: owner })).json()
      .items as {
      key: string
      ru: string | null
      group: string | null
      version: number
      uses: number
    }[]

  it('renames and regroups a tag by its version', async () => {
    const tender = (await tags()).find((tag) => tag.key === 'tender')
    const url = '/api/v1/admin/tags/tender'
    const body = { ru: 'нежно', group: 'mood' }
    expect(
      (await call(server.app, { method: 'PATCH', url, as: owner, key: newKey(), body })).statusCode,
    ).toBe(428)
    const response = await call(server.app, {
      method: 'PATCH',
      url,
      as: owner,
      key: newKey(),
      ifMatch: tender?.version,
      body,
    })
    expect(response.json()).toMatchObject({
      key: 'tender',
      ru: 'нежно',
      version: (tender?.version ?? 0) + 1,
    })
    const stale = await call(server.app, {
      method: 'PATCH',
      url,
      as: owner,
      key: newKey(),
      ifMatch: tender?.version,
      body,
    })
    expect(stale.statusCode).toBe(412)
  })

  it('merges a free tag into a known one', async () => {
    const response = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/tags/${encodeURIComponent('свой тег')}:merge`,
      as: owner,
      key: newKey(),
      body: { into: 'lace' },
    })
    expect(response.statusCode).toBe(200)
    expect((await page('PPV-073')).entry.tags).toContain('lace')
    expect((await tags()).map((tag) => tag.key)).not.toContain('свой тег')
  })
})

it('«Недавние» shows what the person changed', async () => {
  const response = await call(server.app, { method: 'GET', url: '/api/v1/lora/recent', as: owner })
  const items = response.json().items as { item_id: string }[]
  expect(items.map((item) => item.item_id)).toEqual(expect.arrayContaining(['PPV-073', 'CUS-181']))
})
