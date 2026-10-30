import {
  type ApiClient,
  type CatalogEntry,
  createApiClient,
  createFrozenClock,
} from '@contentops/contracts'
import { createMockFetch, PROTOTYPE_NOW } from '@contentops/mock-api'
import { beforeAll, describe, expect, it } from 'vitest'
import { type CatalogSearch, createCatalogSearch, tagNames } from './catalog-search'
import { mergeFound } from './search'

const lora = { model: 'lora' }
let api: ApiClient
let items: readonly CatalogEntry[]
let search: CatalogSearch

beforeAll(async () => {
  api = createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW) }),
  )
  items = (await api.objects.catalogIndex({ params: lora })).items
  search = createCatalogSearch(items, tagNames((await api.admin.tags({})).items))
})

const ids = (query: string, limit?: number) => search.find(query, limit).map((entry) => entry.id)
const typesOf = (query: string) => new Set(search.find(query).map((entry) => entry.type))

describe('поиск по индексу в браузере (DESIGN §4.7)', () => {
  it('примеры из строки поиска: «ппв 73, кастом в колготках, фуп у зеркала»', () => {
    expect(ids('ппв 73')).toEqual(['PPV-073'])
    expect(ids('кастом в колготках', 2)).toEqual(['CUS-186', 'CUS-183'])
    expect(typesOf('кастом в колготках')).toEqual(new Set(['custom']))
    expect(typesOf('фуп у зеркала')).toEqual(new Set(['fyp']))
    expect(ids('фуп у зеркала').length).toBeGreaterThan(0)
  })

  it('примеры §4.7: формы слов, слова-типы и слова чаттеров', () => {
    expect(ids('кружева')).toContain('PPV-073')
    expect(ids('фуп в чёрном белье')).toContain('FYP-0022')
    expect(typesOf('фуп в чёрном')).toEqual(new Set(['fyp']))
    const long = search.find('лонг ппв')
    expect(long).toHaveLength(38)
    expect(long.every((entry) => entry.type === 'ppv' && entry.ppv_kind === 'dm')).toBe(true)
    const sextings = search.find('последние сексты')
    expect(sextings).toHaveLength(12)
    expect(sextings.map((entry) => entry.arrived_on)).toEqual(
      sextings
        .map((entry) => entry.arrived_on)
        .sort()
        .reverse(),
    )
  })

  it('название выше тегов: «Йога и анал» и PPV-073 — в первых шести', () => {
    expect(ids('анал', 6)[0]).toBe('PPV-069')
    expect(ids('кружево', 6)).toContain('PPV-073')
  })

  it('совпадает с сервером: то же число по каждому типу', async () => {
    for (const query of ['кастом в колготках', 'кружева', 'фуп в чёрном', 'лонг ппв', 'йога']) {
      const server = await api.objects.search({ params: lora, query: { q: query } })
      const local = search.find(query)
      for (const group of server.groups) {
        expect(local.filter((entry) => entry.type === group.type).length).toBe(group.total)
      }
    }
  })

  it('окно выбора ищет так же по своему списку: «лайф 191»', () => {
    const lives = items.filter((entry) => entry.type === 'life')
    const picker = createCatalogSearch(lives)
    expect(picker.find('лайф 191').map((entry) => entry.id)).toEqual(['LIFE-191'])
    expect(picker.find('ппв 73')).toEqual([])
  })

  it('найденное сервером по описанию идёт после найденного индексом', async () => {
    const server = await api.objects.search({ params: lora, query: { q: 'свечами' } })
    const byId = new Map(items.map((entry) => [entry.id, entry]))
    const local = search.find('свечами')
    expect(local.map((entry) => entry.id)).not.toContain('PPV-073')
    expect(mergeFound(local, server, byId).map((entry) => entry.id)).toContain('PPV-073')
  })
})
