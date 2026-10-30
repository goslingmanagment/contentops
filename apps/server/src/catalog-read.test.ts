import { CatalogIndexSchema } from '@contentops/contracts/domain/catalog'
import { ItemDetailSchema } from '@contentops/contracts/domain/item'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createCatalogItems,
  linkCatalogItems,
  tombstoneCatalogItem,
} from './testing/catalog-factory'
import { OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * Reading the catalog (PLAN 2а): the index with its content ETag, the object page, resolve
 * with every parser form and old numbers, search in both languages, keyset lists, deleted
 * objects, «Разметка на проверку», the journal of an object and the tag dictionary.
 */

let server: TestServer
let owner: string

const get = (url: string, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'GET', url, headers: { cookie: `co_session=${owner}`, ...headers } })

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  await createCatalogItems(server.db, 'lora', [
    { type: 'raw', number: 34, title: 'Съёмка 12.08', rawPurpose: 'ppv', files: [{ role: 'raw' }] },
    {
      type: 'custom',
      number: 181,
      title: 'нейлон и каблуки',
      nameInMedia: 'no',
      files: [{ role: 'master', durationS: 420 }],
    },
    {
      type: 'ppv',
      number: 73,
      title: 'Вечеринка, блёстки, диван',
      titleEn: 'glitter-party',
      description: 'Танцует в блёстках, потом на диване',
      tags: ['dance', 'lace', 'pov'],
      confirmed: ['title', 'tags'],
      platformTexts: { wall: 'Glitter party', message: 'Wanna see the end?' },
      aliases: [
        { kind: 'legacy_id', value: 'PPV-032' },
        { kind: 'legacy_path', value: '1. PPV/[PPV-073]_party_12.08.26' },
      ],
      files: [
        {
          role: 'master',
          durationS: 600,
          versions: 2,
          chronology: [
            { atS: 0, text: 'приветствие' },
            { atS: 250, text: 'танец у зеркала' },
          ],
        },
        { role: 'teaser', durationS: 30 },
        { role: 'pic' },
        { role: 'pic' },
      ],
    },
    {
      type: 'ppv',
      number: 66,
      title: 'Красное платье, отель',
      tags: ['stockings'],
      confirmed: 'all',
      aliases: [{ kind: 'legacy_id', value: 'PPV-032' }],
      files: [{ role: 'master' }],
    },
    {
      type: 'fyp',
      number: 412,
      title: 'Чулки, танец',
      tags: ['stockings', 'steadycontent'],
      confirmed: 'all',
      files: [
        { role: 'master', durationS: 9 },
        { role: 'master', variant: 2, uniqLevel: 'trim' },
      ],
    },
    {
      type: 'set',
      number: 69,
      title: 'Кружево у окна',
      files: [{ role: 'raw', selected: true }, { role: 'raw' }, { role: 'ed', ordinal: 1 }],
    },
    {
      type: 'life',
      number: 191,
      title: 'Завтрак у окна',
      files: [{ role: 'pic', lifeUse: 'feed' }, { role: 'pic' }],
    },
    { type: 'ppv', number: 50, title: 'Слитый', files: [{ role: 'master' }] },
  ])
  await createCatalogItems(server.db, 'ari', [
    { type: 'ppv', number: 73, title: 'Чужая вечеринка', files: [{ role: 'master' }] },
  ])
  await linkCatalogItems(server.db, 'lora', [
    { child: 'PPV-073', parent: 'RAW-0034', relation: 'montage_from' },
    { child: 'PPV-073', parent: 'CUS-181', relation: 'ppv_from_custom', suggested: true },
  ])
  await tombstoneCatalogItem(server.db, 'lora', 'PPV-050')
})
afterAll(() => server.close())

describe('catalog index', () => {
  it('lists the live objects of the model only, with the fields of SPEC §12.0', async () => {
    const response = await get('/api/v1/lora/index')
    expect(response.statusCode).toBe(200)
    const index = CatalogIndexSchema.parse(response.json())
    const ids = index.items.map((entry) => entry.id).sort()
    expect(ids).toEqual(
      ['CUS-181', 'FYP-0412', 'LIFE-191', 'PPV-066', 'PPV-073', 'RAW-0034', 'SET-069'].sort(),
    )
    const ppv = index.items.find((entry) => entry.id === 'PPV-073')
    expect(ppv).toMatchObject({
      type: 'ppv',
      title_en: 'glitter-party',
      tags: ['dance', 'lace', 'pov'],
      markup: 'partial',
      duration_s: 600,
      photo_count: 2,
      version_count: 2,
      has_teaser: true,
      ppv_kind: 'bundle',
      aliases: ['PPV-032'],
    })
    expect(index.items.find((entry) => entry.id === 'CUS-181')).toMatchObject({
      ppv_made_as: 'PPV-073',
      fan_name: 'no',
    })
    expect(index.items.find((entry) => entry.id === 'FYP-0412')).toMatchObject({
      steady_content: true,
      markup: 'confirmed',
    })
    expect(index.items.find((entry) => entry.id === 'SET-069')).toMatchObject({
      selected_count: 1,
      processed_count: 1,
    })
    expect(index.items.find((entry) => entry.id === 'RAW-0034')?.raw_purpose).toBe('ppv')
  })

  it('keeps its ETag while nothing changes and answers 304', async () => {
    const first = await get('/api/v1/lora/index')
    const second = await get('/api/v1/lora/index')
    const etag = String(first.headers.etag)
    expect(etag).toBe(first.json().etag)
    expect(second.headers.etag).toBe(etag)
    const again = await get('/api/v1/lora/index', { 'if-none-match': etag })
    expect(again.statusCode).toBe(304)
    expect(again.body).toBe('')
    expect(again.headers.etag).toBe(etag)
  })

  it('changes its ETag when an object changes', async () => {
    const before = String((await get('/api/v1/lora/index')).headers.etag)
    await createCatalogItems(server.db, 'lora', [{ type: 'sexting', title: 'Переписка' }])
    const after = await get('/api/v1/lora/index', { 'if-none-match': before })
    expect(after.statusCode).toBe(200)
    expect(after.headers.etag).not.toBe(before)
  })

  it('page summaries are empty until placements exist, with their own ETag', async () => {
    const response = await get('/api/v1/lora/index/pages')
    expect(response.json()).toMatchObject({ model: 'lora', entries: [] })
    const etag = String(response.headers.etag)
    expect((await get('/api/v1/lora/index/pages', { 'if-none-match': etag })).statusCode).toBe(304)
  })
})

describe('object page', () => {
  it('shows files with handles, versions, markup with states and provenance', async () => {
    const response = await get('/api/v1/lora/i/PPV-073')
    expect(response.statusCode).toBe(200)
    const detail = ItemDetailSchema.parse(response.json())
    expect(response.headers.etag).toBe(`"${detail.version}"`)
    expect(detail.files.map((file) => [file.key, file.role])).toEqual([
      ['master', 'master'],
      ['teaser', 'teaser'],
      ['pic01', 'photo'],
      ['pic02', 'photo'],
    ])
    expect(detail.files[0]?.versions.map((version) => version.no)).toEqual([1, 2])
    const status = Object.fromEntries(detail.markup.map((field) => [field.field.key, field.status]))
    expect(status).toEqual({
      title: 'confirmed',
      title_en: 'draft_import',
      tags: 'confirmed',
      description: 'draft_import',
      timeline: 'draft_import',
      platform_texts: 'draft_import',
    })
    const timeline = detail.markup.find((field) => field.field.key === 'timeline')
    expect(timeline?.field.value).toEqual([
      { start_s: 0, label: 'приветствие' },
      { start_s: 250, label: 'танец у зеркала' },
    ])
    expect(detail.provenance).toEqual([
      expect.objectContaining({ item_id: 'RAW-0034', direction: 'out', confirmed: true }),
      expect.objectContaining({
        item_id: 'CUS-181',
        relation: 'ppv_from_custom',
        confirmed: false,
      }),
    ])
    expect(detail.ydisk.path).toBe('1. PPV/[PPV-073]_party_12.08.26')
    expect(detail.pages.map((page) => [page.account, page.summary.word])).toEqual([
      ['lora-1', 'не видели'],
      ['lora-of', 'не видели'],
    ])
  })

  it('keeps unique FYP versions apart from the montage', async () => {
    const detail = ItemDetailSchema.parse((await get('/api/v1/lora/i/FYP-0412')).json())
    expect(detail.files.map((file) => file.role)).toEqual(['montage'])
    expect(detail.fyp_versions).toEqual([expect.objectContaining({ no: 2, level: 'trim' })])
  })

  it('shows a deleted object with its tombstone and 404 for what the model lacks', async () => {
    const deleted = ItemDetailSchema.parse((await get('/api/v1/lora/i/PPV-050')).json())
    expect(deleted.lifecycle.state).toBe('deleted')
    expect((await get('/api/v1/lora/i/PPV-999')).statusCode).toBe(404)
    expect((await get('/api/v1/lora/i/not-an-id')).statusCode).toBe(404)
  })
})

describe('resolve', () => {
  it.each(['ppv73', 'PPV 73', 'ппв-73', '[PPV-073]', 'ппв 73', '#ppv73'])('reads %s', async (q) => {
    const response = await get(`/api/v1/lora/resolve?q=${encodeURIComponent(q)}`)
    expect(response.json()).toMatchObject({ item_id: 'PPV-073', parsed: `${q} → PPV-073` })
  })

  it('names every object that had an old number', async () => {
    const response = await get(`/api/v1/lora/resolve?q=${encodeURIComponent('ппв 32')}`)
    expect(response.json()).toMatchObject({
      item_id: null,
      old_number: { number: 'PPV-032', items: ['PPV-066', 'PPV-073'] },
    })
  })

  it('reads a section name and numbers past the padding', async () => {
    expect((await get('/api/v1/lora/resolve?q=план')).json()).toMatchObject({ section: 'plan' })
    expect((await get('/api/v1/lora/resolve?q=ppv1000')).json()).toMatchObject({
      parsed: 'ppv1000 → PPV-1000',
      item_id: null,
    })
  })
})

describe('search', () => {
  const search = async (q: string) =>
    (await get(`/api/v1/lora/search?q=${encodeURIComponent(q)}`)).json()
  const found = (result: { groups: { item_ids: string[] }[] }) =>
    result.groups.flatMap((group) => group.item_ids)

  it('finds an ID with its old-number holders', async () => {
    expect(found(await search('ппв 73'))).toEqual(['PPV-073'])
    expect(found(await search('PPV-032')).sort()).toEqual(['PPV-066', 'PPV-073'])
  })

  it('finds Russian words by stem, English titles and tag names', async () => {
    expect(found(await search('вечеринки'))).toEqual(['PPV-073'])
    expect(found(await search('glitter'))).toEqual(['PPV-073'])
    expect(found(await search('чулки')).sort()).toEqual(['FYP-0412', 'PPV-066'])
    expect(found(await search('фуп чулки'))).toEqual(['FYP-0412'])
  })

  it('finds descriptions, old paths and chronology on the server', async () => {
    expect(found(await search('диване'))).toEqual(['PPV-073'])
    expect(found(await search('party'))).toEqual(['PPV-073'])
    const timeline = await search('зеркала')
    expect(timeline.timeline).toEqual([{ item_id: 'PPV-073', t_s: 250, label: 'танец у зеркала' }])
  })

  it('never finds another model or a tombstone', async () => {
    expect(found(await search('чужая'))).toEqual([])
    expect(found(await search('слитый'))).toEqual([])
  })
})

describe('lists', () => {
  it('pages the items by keyset and binds the cursor to the filters', async () => {
    const first = (await get('/api/v1/lora/items?type=ppv&limit=1')).json()
    expect(first.items).toHaveLength(1)
    expect(first.next_cursor).toBeTruthy()
    const second = (
      await get(`/api/v1/lora/items?type=ppv&limit=1&cursor=${first.next_cursor}`)
    ).json()
    expect(second.items[0].id).not.toBe(first.items[0].id)
    expect(second.next_cursor).toBeNull()
    const other = await get(`/api/v1/lora/items?type=fyp&cursor=${first.next_cursor}`)
    expect(other.statusCode).toBe(400)
    const tagged = (await get('/api/v1/lora/items?tag=stockings')).json()
    expect(tagged.items.map((entry: { id: string }) => entry.id).sort()).toEqual([
      'FYP-0412',
      'PPV-066',
    ])
    expect((await get('/api/v1/lora/items?where=lora-1:yes')).json().items).toEqual([])
  })

  it('lists deleted objects', async () => {
    const response = await get('/api/v1/lora/deleted')
    expect(response.json().items).toEqual([
      expect.objectContaining({ item_id: 'PPV-050', merged_into: null }),
    ])
  })

  it('puts objects with draft fields into «Разметка на проверку»', async () => {
    const items = (await get('/api/v1/lora/markup/review')).json().items
    const ids = items.map((item: { item_id: string }) => item.item_id)
    expect(ids).toContain('PPV-073')
    expect(ids).not.toContain('PPV-066')
    expect(ids).not.toContain('FYP-0412')
  })

  it('shows the journal of one object', async () => {
    const events = (await get('/api/v1/lora/journal?item=PPV-073')).json().items
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event: { item_id: string }) => event.item_id === 'PPV-073')).toBe(true)
  })

  it('lists the shared dictionary with uses and the model’s free tags', async () => {
    const tags = (await get('/api/v1/admin/tags')).json().items
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: 'stockings', ru: 'чулки', group: 'attribute', uses: 2, version: 1 },
        { key: 'pov', ru: null, group: null, uses: 1, version: 1 },
      ]),
    )
  })
})
