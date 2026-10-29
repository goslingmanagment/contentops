import {
  type CatalogEntry,
  compareSearchHits,
  entryHaystack,
  type ModelCode,
  parseSearchQuery,
  type SearchHaystack,
  type SearchRank,
  searchRank,
  type Tag,
} from '@contentops/contracts'
import { useMemo } from 'react'
import { useCatalogIndex, useTags } from './catalog'

/**
 * Мгновенный поиск по индексу в браузере: ID, название, старые номера и русские имена
 * тегов. Запрос разбирается так же, как на сервере (`parseSearchQuery`): формы слов,
 * слова-типы («кастом», «фуп», «сексты») и слова чаттеров («лонг ппв»). Серверная часть
 * (описания, старые имена, хронология, черновики) — `useSearchResults`.
 */
export interface CatalogSearch {
  /** Найденное: сначала ID и названия, потом теги, внутри — новые первыми. */
  find(query: string, limit?: number): CatalogEntry[]
}

export interface SearchHit {
  entry: CatalogEntry
  rank: SearchRank
}

interface Prepared {
  entry: CatalogEntry
  haystack: SearchHaystack
}

export function tagNames(tags: readonly Tag[] | undefined): ReadonlyMap<string, string> {
  return new Map((tags ?? []).map((tag) => [tag.key, tag.ru ?? tag.key]))
}

/** Найденное с местом совпадения, по порядку выдачи. */
export function searchHits(
  prepared: readonly Prepared[],
  query: string,
  limit = Number.POSITIVE_INFINITY,
): SearchHit[] {
  const parsed = parseSearchQuery(query)
  const hits: SearchHit[] = []
  for (const { entry, haystack } of prepared) {
    const rank = searchRank(parsed, entry, haystack)
    if (rank !== null) {
      hits.push({ entry, rank })
    }
  }
  return hits.sort(compareSearchHits).slice(0, limit)
}

export function createCatalogSearch(
  items: readonly CatalogEntry[],
  names: ReadonlyMap<string, string> = new Map(),
): CatalogSearch {
  const prepared = items.map((entry) => ({
    entry,
    haystack: entryHaystack(entry, (key) => names.get(key) ?? key),
  }))
  return {
    find: (query, limit) => searchHits(prepared, query, limit).map((hit) => hit.entry),
  }
}

export function useCatalogSearch(model: ModelCode): CatalogSearch | null {
  const index = useCatalogIndex(model).data
  const tags = useTags().data
  return useMemo(
    () => (index ? createCatalogSearch(index.items, tagNames(tags)) : null),
    [index, tags],
  )
}

/**
 * Поиск по готовому списку окна выбора (DESIGN §3.13, §4.13): тот же разбор запроса, что
 * у верхней строки, пустой запрос отдаёт список как есть.
 */
export function useEntriesSearch(
  entries: readonly CatalogEntry[],
  query: string,
): readonly CatalogEntry[] {
  const tags = useTags().data
  const search = useMemo(() => createCatalogSearch(entries, tagNames(tags)), [entries, tags])
  return useMemo(() => (query.trim() ? search.find(query) : entries), [search, query, entries])
}
