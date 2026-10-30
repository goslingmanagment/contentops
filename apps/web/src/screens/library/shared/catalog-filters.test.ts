import {
  type ApiClient,
  type CatalogEntry,
  createApiClient,
  createFrozenClock,
} from '@contentops/contracts'
import { createMockFetch, PROTOTYPE_NOW } from '@contentops/mock-api'
import { beforeAll, describe, expect, it } from 'vitest'
import { type PageSummariesView, pageSummariesView } from '@/data/catalog'
import {
  CLEARED_FILTERS,
  type FilterContext,
  filterEntries,
  formatWhere,
  hasActiveFilters,
  isPlacedOn,
  parseWhere,
  pickFilters,
  whereConditions,
} from './catalog-filters'

const lora = { model: 'lora' }
const today = '2026-09-22'
let api: ApiClient
let items: readonly CatalogEntry[]
let summaries: PageSummariesView
let context: FilterContext

beforeAll(async () => {
  api = createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW) }),
  )
  items = (await api.objects.catalogIndex({ params: lora })).items
  summaries = pageSummariesView(await api.objects.pageSummaries({ params: lora }), null)
  context = { summaries, today }
})

const ppv = () => items.filter((entry) => entry.type === 'ppv')

describe('чип «Где залито ▾» (DESIGN §4.2)', () => {
  it('значение адреса разбирается и собирается обратно', () => {
    expect(parseWhere('lora-2:no')).toEqual({ account: 'lora-2', placed: false })
    expect(parseWhere('lora-1:yes')).toEqual({ account: 'lora-1', placed: true })
    expect(parseWhere('lora-1')).toBeNull()
    expect(parseWhere('lora-1:maybe')).toBeNull()
    expect(formatWhere({ account: 'lora-2', placed: false })).toBe('lora-2:no')
    expect(whereConditions({ where: ['lora-2:no', 'мусор', 'lora-1:yes'] })).toHaveLength(2)
  })

  it('«нет на Fansly 2» и «есть на Fansly 2» делят раздел без остатка', () => {
    const no = filterEntries(ppv(), { where: ['lora-2:no'] }, context)
    const yes = filterEntries(ppv(), { where: ['lora-2:yes'] }, context)
    expect(no.length + yes.length).toBe(ppv().length)
    expect(no.length).toBeGreaterThan(0)
    expect(yes.every((entry) => isPlacedOn(summaries, entry.id, 'lora-2'))).toBe(true)
  })

  it('чип можно поставить дважды: «есть на Fansly 1, нет на Fansly 2»', () => {
    const both = filterEntries(ppv(), { where: ['lora-1:yes', 'lora-2:no'] }, context)
    for (const entry of both) {
      expect(isPlacedOn(summaries, entry.id, 'lora-1')).toBe(true)
      expect(isPlacedOn(summaries, entry.id, 'lora-2')).toBe(false)
    }
  })
})

describe('чипы раздела (DESIGN §4.2)', () => {
  it('без фильтров — все объекты', () => {
    expect(filterEntries(items, {}, context)).toHaveLength(items.length)
  })

  it('«Вид: в личку» — 38 PPV, «Без тизера» и «Без фото» — ровно то, что сказано', () => {
    expect(filterEntries(ppv(), { kind: 'dm' }, context)).toHaveLength(38)
    for (const entry of filterEntries(ppv(), { noteaser: true }, context)) {
      expect(entry.has_teaser).toBe(false)
    }
    for (const entry of filterEntries(ppv(), { nophotos: true }, context)) {
      expect(entry.photo_count ?? 0).toBe(0)
    }
  })

  it('теги — все выбранные сразу', () => {
    const [first] = ppv().filter((entry) => entry.tags.length >= 2)
    if (!first) throw new Error('нет PPV с двумя тегами')
    const [a, b] = first.tags
    const found = filterEntries(items, { tag: [a ?? '', b ?? ''] }, context)
    expect(found).toContain(first)
    expect(
      found.every((entry) => entry.tags.includes(a ?? '') && entry.tags.includes(b ?? '')),
    ).toBe(true)
  })

  it('«Дата ▾ · неделя» — пришло за последние 7 дней, включая сегодня', () => {
    const week = filterEntries(items, { period: 'week' }, context)
    expect(week.length).toBeGreaterThan(0)
    expect(week.every((entry) => entry.arrived_on >= '2026-09-16')).toBe(true)
  })

  it('флаги типов: второй человек, не отобран, без назначения, назначение сырья', () => {
    expect(
      filterEntries(items, { second: true }, context).every((entry) => entry.second_person),
    ).toBe(true)
    expect(
      filterEntries(items, { unpicked: true }, context).every(
        (entry) => (entry.selected_count ?? 0) === 0,
      ),
    ).toBe(true)
    expect(
      filterEntries(items, { unassigned: true }, context).every(
        (entry) => (entry.life_unassigned ?? 0) > 0,
      ),
    ).toBe(true)
    expect(
      filterEntries(items, { purpose: 'ppv' }, context).every(
        (entry) => entry.raw_purpose === 'ppv',
      ),
    ).toBe(true)
  })

  it('«Сбросить» появляется, только когда что-то включено', () => {
    expect(hasActiveFilters({})).toBe(false)
    expect(hasActiveFilters(CLEARED_FILTERS)).toBe(false)
    expect(hasActiveFilters({ where: [] })).toBe(false)
    expect(hasActiveFilters({ kind: 'dm' })).toBe(true)
    expect(hasActiveFilters({ where: ['lora-2:no'] })).toBe(true)
  })

  it('из адреса берутся только фильтры, вид и сортировка отбрасываются', () => {
    const search = { kind: 'dm', view: 'grid', sort: 'number' } as never
    expect(pickFilters(search)).toEqual({ kind: 'dm' })
  })
})
