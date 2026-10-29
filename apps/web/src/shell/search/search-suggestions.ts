import {
  type CatalogEntry,
  formatNumber,
  normalizeQuery,
  parseIdQuery,
  parseSearchQuery,
  plural,
  searchTokens,
  sectionOfQuery,
  stemMatches,
  type TimelineHit,
} from '@contentops/contracts'
import type { CatalogIndexView } from '@/data/catalog'
import { NAMED_DESTINATIONS, type NamedDestination } from '../navigation/destinations'

/**
 * Подсказки верхнего поиска (DESIGN §2.1, §4.7) — тот же разбор запроса, что у страницы
 * результатов: ID в любом виде («ппв 73», «[PPV-073]», «cus183»), старые номера, разделы
 * и папки, первые 6 найденных объектов и хронология из ответа сервера. Последняя строка
 * всегда ведёт на экран поиска.
 */
export type Suggestion =
  | { key: string; kind: 'item'; entry: CatalogEntry; exact: boolean }
  | { key: string; kind: 'destination'; destination: NamedDestination }
  | { key: string; kind: 'timeline'; hit: TimelineHit; entry: CatalogEntry | undefined }
  | { key: string; kind: 'all'; query: string }

export interface SuggestionGroup {
  label: string | null
  items: Suggestion[]
}

export interface Suggestions {
  groups: SuggestionGroup[]
  /** Строка, активная без стрелок: по ней идёт `Enter`. */
  activeKey: string | null
}

/** «у трёх папок»: малые числа словами, как в речи. */
const GENITIVE_NUMBERS: Readonly<Record<number, string>> = { 2: 'двух', 3: 'трёх', 4: 'четырёх' }

function foldersCount(count: number): string {
  const number = GENITIVE_NUMBERS[count] ?? formatNumber(count)
  return `${number} ${plural(count, ['папки', 'папок', 'папок'])}`
}

const MAX_OBJECTS = 6
const MAX_DESTINATIONS = 3
const MAX_TIMELINE = 3
const MIN_WORD_LENGTH = 2

function itemSuggestion(entry: CatalogEntry, exact: boolean): Suggestion {
  return { key: `item:${entry.id}`, kind: 'item', entry, exact }
}

/** Раздел назван целиком: «план», «заказы», «приехало», «кастом». */
function namesDestination(query: string, named: NamedDestination): boolean {
  const section = sectionOfQuery(query)
  if (section && named.destination.kind === 'section' && named.destination.section === section) {
    return true
  }
  if (section === 'check' && named.destination.kind === 'check') {
    return true
  }
  if (section === 'orders' && named.destination.kind === 'orders') {
    return true
  }
  const normalized = normalizeQuery(query)
  return [named.label, ...named.aliases].some((word) => normalizeQuery(word) === normalized)
}

/** Раздел или папка, названные запросом целиком: «план», «заказы», «кастом». */
export function namedDestinationOf(query: string): NamedDestination | null {
  return NAMED_DESTINATIONS.find((named) => namesDestination(query, named)) ?? null
}

/** Разделы, чьё имя начинается с запроса; названный целиком — первым. */
function matchingDestinations(query: string): { list: NamedDestination[]; exact: boolean } {
  const normalized = normalizeQuery(query)
  if (normalized.length < MIN_WORD_LENGTH) {
    return { list: [], exact: false }
  }
  const exact = NAMED_DESTINATIONS.filter((named) => namesDestination(query, named))
  const prefix = NAMED_DESTINATIONS.filter(
    (named) =>
      !exact.includes(named) &&
      [named.label, ...named.aliases].some((word) => normalizeQuery(word).startsWith(normalized)),
  )
  return { list: [...exact, ...prefix].slice(0, MAX_DESTINATIONS), exact: exact.length > 0 }
}

/**
 * Минута, которая отвечает на запрос целиком: слово типа и все слова в подписи отрезка —
 * «анал кастом» → «CUS-181 · 04:10 — анал» (§6.11: `/`, запрос, `Enter`).
 */
function answersWithMinute(query: string, hit: TimelineHit): boolean {
  const parsed = parseSearchQuery(query)
  const words = searchTokens(hit.label)
  return (
    parsed.type !== null &&
    parsed.stems.length > 0 &&
    parsed.stems.every((stem) => stemMatches(stem, words))
  )
}

interface SuggestionSources {
  index: CatalogIndexView | undefined
  /** Найденное тем же поиском, что и страница результатов, по порядку выдачи. */
  found: readonly CatalogEntry[]
  /** Хронология из ответа сервера; пока его нет — пусто. */
  timeline: readonly TimelineHit[]
}

export function buildSuggestions(
  query: string,
  { index, found, timeline }: SuggestionSources,
): Suggestions {
  const trimmed = query.trim()
  if (!trimmed) {
    return { groups: [], activeKey: null }
  }
  const groups: SuggestionGroup[] = []
  const shown = new Set<string>()
  let activeKey: string | null = null

  const destinations = matchingDestinations(trimmed)
  if (destinations.list.length > 0) {
    const items: Suggestion[] = destinations.list.map((destination) => ({
      key: `destination:${destination.label}`,
      kind: 'destination',
      destination,
    }))
    groups.push({ label: 'Разделы', items })
    if (destinations.exact) {
      activeKey = items[0]?.key ?? null
    }
  }

  const id = parseIdQuery(trimmed)
  const exact = id ? index?.byId.get(id) : undefined
  if (exact) {
    const item = itemSuggestion(exact, true)
    groups.push({ label: 'Объект', items: [item] })
    shown.add(exact.id)
    activeKey ??= item.key
  }

  const holders = id ? (index?.items.filter((entry) => entry.aliases.includes(id)) ?? []) : []
  const otherHolders = holders.filter((entry) => !shown.has(entry.id))
  if (id && otherHolders.length > 0) {
    const count = holders.length + (exact && !holders.includes(exact) ? 1 : 0)
    groups.push({
      label: `Старый номер ${id} был у ${foldersCount(count)}`,
      items: otherHolders.map((entry) => itemSuggestion(entry, false)),
    })
    for (const entry of otherHolders) {
      shown.add(entry.id)
    }
  }

  if (!id) {
    const objects = found.filter((entry) => !shown.has(entry.id)).slice(0, MAX_OBJECTS)
    if (objects.length > 0) {
      groups.push({ label: 'Объекты', items: objects.map((entry) => itemSuggestion(entry, false)) })
    }
  }

  if (timeline.length > 0) {
    const items: Suggestion[] = timeline.slice(0, MAX_TIMELINE).map((hit) => ({
      key: `timeline:${hit.item_id}:${hit.t_s}`,
      kind: 'timeline',
      hit,
      entry: index?.byId.get(hit.item_id),
    }))
    groups.push({ label: 'В хронологии', items })
    const first = timeline[0]
    if (first && answersWithMinute(trimmed, first)) {
      activeKey ??= items[0]?.key ?? null
    }
  }

  groups.push({ label: null, items: [{ key: 'all', kind: 'all', query: trimmed }] })
  return { groups, activeKey }
}
