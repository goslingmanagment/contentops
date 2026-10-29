import {
  type AccountCode,
  addDays,
  type CatalogEntry,
  type ItemId,
  type LocalDate,
} from '@contentops/contracts'
import { type PageSummariesView, pageSummaryOf } from '@/data/catalog'
import { type CatalogFilters, CatalogFiltersSchema, type Period } from '../search'

/**
 * Мгновенные фильтры каталога (DESIGN §3.13, §4.2): всё считается по индексу в браузере,
 * без запроса. Каждое правило смотрит на свой параметр адреса и либо молчит, либо
 * отбирает объекты; объект проходит, если прошёл все включённые правила.
 */

export interface FilterContext {
  summaries: PageSummariesView | undefined
  today: LocalDate
}

export interface WhereCondition {
  account: AccountCode
  /** `true` — «есть на странице», `false` — «нет». */
  placed: boolean
}

export function parseWhere(value: string): WhereCondition | null {
  const [account, answer] = value.split(':')
  if (!account || (answer !== 'yes' && answer !== 'no')) {
    return null
  }
  return { account, placed: answer === 'yes' }
}

export function formatWhere(condition: WhereCondition): string {
  return `${condition.account}:${condition.placed ? 'yes' : 'no'}`
}

export function whereConditions(filters: Pick<CatalogFilters, 'where'>): WhereCondition[] {
  return (filters.where ?? []).flatMap((value) => {
    const condition = parseWhere(value)
    return condition ? [condition] : []
  })
}

/** Залит ли объект на страницу: размещение любого уровня, как у сервера. */
export function isPlacedOn(
  summaries: PageSummariesView | undefined,
  id: ItemId,
  account: AccountCode,
): boolean {
  return (pageSummaryOf(summaries, id, account)?.placed_on.length ?? 0) > 0
}

const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, quarter: 91, year: 365 }

type Predicate = (entry: CatalogEntry) => boolean
type Rule = (filters: CatalogFilters, context: FilterContext) => Predicate | null

const count = (value: number | null) => value ?? 0

const RULES: readonly Rule[] = [
  (filters, { summaries }) => {
    const conditions = whereConditions(filters)
    return conditions.length === 0
      ? null
      : (entry) =>
          conditions.every(
            (condition) => isPlacedOn(summaries, entry.id, condition.account) === condition.placed,
          )
  },
  ({ tag }) => (tag?.length ? (entry) => tag.every((key) => entry.tags.includes(key)) : null),
  ({ markup }) => (markup ? (entry) => entry.markup === markup : null),
  ({ period }, { today }) => {
    if (!period) {
      return null
    }
    const from = addDays(today, 1 - PERIOD_DAYS[period])
    return (entry) => entry.arrived_on >= from
  },
  ({ second }) => (second ? (entry) => entry.second_person : null),
  ({ kind }) => (kind ? (entry) => entry.ppv_kind === kind : null),
  ({ noteaser }) => (noteaser ? (entry) => !entry.has_teaser : null),
  ({ nophotos }) => (nophotos ? (entry) => count(entry.photo_count) === 0 : null),
  ({ nover }, { summaries }) =>
    nover ? (entry) => !pageSummaryOf(summaries, entry.id, nover)?.has_fyp_version : null,
  ({ steady }) => (steady ? (entry) => entry.steady_content : null),
  ({ name }) => (name ? (entry) => entry.fan_name === name : null),
  ({ photo }) => (photo ? (entry) => entry.photo_custom : null),
  ({ unpicked }) => (unpicked ? (entry) => count(entry.selected_count) === 0 : null),
  ({ unassigned }) => (unassigned ? (entry) => count(entry.life_unassigned) > 0 : null),
  ({ use }) =>
    use
      ? (entry) => count(use === 'feed' ? entry.life_feed_count : entry.life_chat_count) > 0
      : null,
  ({ purpose }) => (purpose ? (entry) => entry.raw_purpose === purpose : null),
]

export function filterEntries(
  entries: readonly CatalogEntry[],
  filters: CatalogFilters,
  context: FilterContext,
): CatalogEntry[] {
  const active = RULES.flatMap((rule) => {
    const predicate = rule(filters, context)
    return predicate ? [predicate] : []
  })
  return active.length === 0
    ? [...entries]
    : entries.filter((entry) => active.every((predicate) => predicate(entry)))
}

/** Включён ли хоть один фильтр: справа от чипов появляется «Сбросить». */
export function hasActiveFilters(filters: CatalogFilters): boolean {
  return Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false,
  )
}

/** Все фильтры выключены: подмешивается в адрес, остальные параметры не трогаются. */
export const CLEARED_FILTERS: Record<keyof CatalogFilters, undefined> = {
  where: undefined,
  tag: undefined,
  markup: undefined,
  period: undefined,
  second: undefined,
  kind: undefined,
  noteaser: undefined,
  nophotos: undefined,
  nover: undefined,
  steady: undefined,
  name: undefined,
  photo: undefined,
  unpicked: undefined,
  unassigned: undefined,
  use: undefined,
  purpose: undefined,
}

/** Только фильтры из параметров адреса экрана: остальное (вид, сортировка) отбрасывается. */
export function pickFilters(search: CatalogFilters): CatalogFilters {
  return CatalogFiltersSchema.parse(search)
}
