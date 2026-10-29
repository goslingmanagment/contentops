import {
  type ApiClient,
  createApiClient,
  createFrozenClock,
  createMockFetch,
  PROTOTYPE_NOW,
} from '@contentops/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CatalogIndexView } from '@/data/catalog'
import { type CatalogSearch, createCatalogSearch, tagNames } from '@/data/catalog-search'
import { mergeFound } from '@/data/search'
import { buildSuggestions, type Suggestion } from './search-suggestions'

const lora = { model: 'lora' }
let api: ApiClient
let index: CatalogIndexView
let search: CatalogSearch

beforeAll(async () => {
  api = createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW) }),
  )
  const catalog = await api.objects.catalogIndex({ params: lora })
  index = {
    etag: catalog.etag,
    generatedAt: catalog.generated_at,
    items: catalog.items,
    byId: new Map(catalog.items.map((entry) => [entry.id, entry])),
  }
  search = createCatalogSearch(catalog.items, tagNames((await api.admin.tags({})).items))
})

/** Подсказки так же, как их строит верхняя строка: индекс и ответ сервера. */
async function suggest(query: string) {
  const server = await api.objects.search({ params: lora, query: { q: query } })
  const found = mergeFound(search.find(query), server, index.byId)
  const result = buildSuggestions(query, { index, found, timeline: server.timeline })
  const flat = result.groups.flatMap((group) => group.items)
  return { ...result, flat, found }
}

const labelOf = (suggestion: Suggestion | undefined) => {
  switch (suggestion?.kind) {
    case 'item':
      return suggestion.entry.id
    case 'destination':
      return suggestion.destination.label
    case 'timeline':
      return `${suggestion.hit.item_id}@${suggestion.hit.t_s}`
    default:
      return suggestion?.kind
  }
}

describe('подсказки верхнего поиска (DESIGN §4.7)', () => {
  it('объекты — первые шесть того же поиска, что у страницы', async () => {
    for (const query of ['кастом в колготках', 'лонг ппв', 'последние сексты', 'кружево']) {
      const { groups, found } = await suggest(query)
      const objects = groups.find((group) => group.label === 'Объекты')?.items ?? []
      expect(objects.map(labelOf)).toEqual(found.slice(0, 6).map((entry) => entry.id))
    }
  })

  it('имя раздела — первая строка и активна: Enter ведёт в раздел', async () => {
    for (const [query, label] of [
      ['план', 'План'],
      ['заказы', 'Заказы'],
      ['приехало', 'Приехало'],
      ['кастом', 'Кастомы'],
    ] as const) {
      const { flat, activeKey } = await suggest(query)
      expect(labelOf(flat[0])).toBe(label)
      expect(activeKey).toBe(flat[0]?.key)
    }
  })

  it('начало имени раздела показывает его первым, но Enter не уводит', async () => {
    const { flat, activeKey } = await suggest('пла')
    expect(labelOf(flat[0])).toBe('План')
    expect(activeKey).toBeNull()
  })

  it('точный ID активен сразу', async () => {
    const { flat, activeKey } = await suggest('ппв 73')
    expect(flat.find((item) => item.key === activeKey)).toMatchObject({
      kind: 'item',
      exact: true,
    })
  })

  it('§6.11 «анал кастом»: группа «В хронологии», минута активна', async () => {
    const { groups, activeKey } = await suggest('анал кастом')
    const timeline = groups.find((group) => group.label === 'В хронологии')
    expect(timeline?.items.map(labelOf)).toEqual(['CUS-181@250'])
    expect(activeKey).toBe(timeline?.items[0]?.key)
  })

  it('минута без слова типа не перехватывает Enter', async () => {
    const { groups, activeKey } = await suggest('торт')
    expect(groups.some((group) => group.label === 'В хронологии')).toBe(true)
    expect(activeKey).toBeNull()
  })
})
