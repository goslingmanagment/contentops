import {
  type CatalogEntry,
  formatDuration,
  type ItemId,
  type ModelCode,
  type SearchResult,
} from '@contentops/contracts'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useApi } from './api-session'
import { useCatalogIndex } from './catalog'
import { useCatalogSearch } from './catalog-search'
import { queryKeys } from './query-keys'

/** Серверная часть поиска: описания, старые имена, хронология, черновики «Приехало». */
export function useSearchResults(model: ModelCode, query: string) {
  const api = useApi()
  const trimmed = query.trim()
  return useQuery({
    queryKey: queryKeys.search(model, trimmed),
    queryFn: ({ signal }) =>
      api.objects.search({ params: { model }, query: { q: trimmed }, signal }),
    enabled: trimmed.length > 0,
    staleTime: 60_000,
  })
}

function newestFirst(left: CatalogEntry, right: CatalogEntry): number {
  return right.arrived_on.localeCompare(left.arrived_on) || right.id.localeCompare(left.id)
}

/**
 * Найденное индексом и сервером вместе, без повторов. Индекс уже упорядочен (ID и
 * название, потом теги); то, что нашёл только сервер — по описанию и старым именам, —
 * идёт следом, новые первыми.
 */
export function mergeFound(
  local: readonly CatalogEntry[],
  server: SearchResult | undefined,
  byId: ReadonlyMap<ItemId, CatalogEntry> | undefined,
): CatalogEntry[] {
  const seen = new Set(local.map((entry) => entry.id))
  const serverOnly: CatalogEntry[] = []
  for (const group of server?.groups ?? []) {
    for (const id of group.item_ids) {
      const entry = byId?.get(id)
      if (entry && !seen.has(id)) {
        seen.add(id)
        serverOnly.push(entry)
      }
    }
  }
  return [...local, ...serverOnly.sort(newestFirst)]
}

/**
 * Найденные объекты по запросу — одни и те же для подсказок верхней строки и страницы
 * результатов (DESIGN §4.7): индекс отвечает сразу, сервер дописывает описания, старые
 * имена, хронологию и черновики.
 */
export function useFoundObjects(model: ModelCode, query: string) {
  const index = useCatalogIndex(model)
  const local = useCatalogSearch(model)
  const server = useSearchResults(model, query)
  const byId = index.data?.byId
  const localFound = useMemo(() => local?.find(query) ?? [], [local, query])
  const found = useMemo(
    () => mergeFound(localFound, server.data, byId),
    [localFound, server.data, byId],
  )
  return { index, server, found }
}

/** «04:10»: минуты хронологии всегда двумя цифрами, как в плеере. */
export function timelineTimecode(seconds: number): string {
  const text = formatDuration(seconds)
  return text.length === 4 ? `0${text}` : text
}
