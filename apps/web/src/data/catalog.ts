import {
  type AccountCode,
  apiRoutes,
  type CatalogEntry,
  type Instant,
  type ItemId,
  type ModelCode,
  type PageSummaryEntry,
  type PageSummaryIndex,
} from '@contentops/contracts'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { useConditionalQuery } from './conditional-query'
import { queryKeys } from './query-keys'

/**
 * Каталог модели в памяти браузера (DESIGN §3.13): фильтры, поиск по названию и смена
 * типа работают без запроса. Два ресурса со своими ETag — каталог и сводка по страницам.
 */

export interface CatalogIndexView {
  etag: string | null
  generatedAt: Instant
  items: readonly CatalogEntry[]
  byId: ReadonlyMap<ItemId, CatalogEntry>
}

export function useCatalogIndex(model: ModelCode, enabled = true) {
  const api = useApi()
  return useConditionalQuery({
    queryKey: queryKeys.catalogIndex(model),
    enabled,
    fetch: (etag, signal) =>
      api.conditional(apiRoutes.objects.catalogIndex, { params: { model }, etag, signal }),
    toView: (index, etag): CatalogIndexView => ({
      etag: etag ?? index.etag,
      generatedAt: index.generated_at,
      items: index.items,
      byId: new Map(index.items.map((item) => [item.id, item])),
    }),
  })
}

export interface PageSummariesView {
  etag: string | null
  generatedAt: Instant
  entries: readonly PageSummaryEntry[]
  /** Все пары объекта; пары, которых нет, значат «не видели». */
  byItem: ReadonlyMap<ItemId, readonly PageSummaryEntry[]>
}

/** Сводка по страницам с доступом по объекту: плитки и фильтры ищут пары без перебора. */
export function pageSummariesView(index: PageSummaryIndex, etag: string | null): PageSummariesView {
  const byItem = new Map<ItemId, PageSummaryEntry[]>()
  for (const entry of index.entries) {
    const list = byItem.get(entry.item_id)
    if (list) {
      list.push(entry)
    } else {
      byItem.set(entry.item_id, [entry])
    }
  }
  return {
    etag: etag ?? index.etag,
    generatedAt: index.generated_at,
    entries: index.entries,
    byItem,
  }
}

export function usePageSummaries(model: ModelCode, enabled = true) {
  const api = useApi()
  return useConditionalQuery({
    queryKey: queryKeys.pageSummaries(model),
    enabled,
    fetch: (etag, signal) =>
      api.conditional(apiRoutes.objects.pageSummaries, { params: { model }, etag, signal }),
    toView: pageSummariesView,
  })
}

/** Сводка пары «объект × страница»; `undefined` — следов нет, «не видели». */
export function pageSummaryOf(
  view: PageSummariesView | undefined,
  itemId: ItemId,
  account: AccountCode,
): PageSummaryEntry | undefined {
  return view?.byItem.get(itemId)?.find((entry) => entry.account === account)
}

/** «Недавние»: чего касался вошедший, с причиной для подсказки. */
export function useRecent(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.recent(model),
    queryFn: ({ signal }) => api.objects.recent({ params: { model }, signal }),
    select: (page) => page.items,
  })
}

/** Удалённые и слитые объекты (`/<модель>/library/deleted`, «⋯ → Удалённые объекты»). */
export function useDeletedItems(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.deleted(model),
    queryFn: ({ signal }) => api.objects.deleted({ params: { model }, signal }),
    select: (page) => page.items,
  })
}

/**
 * Все вкладки «Ещё не залито» сразу (DESIGN §4.3): строка покрытия и строка Hub у каждой
 * страницы уже на месте, когда человек переходит на её вкладку, — ничего не въезжает.
 */
export function useNotUploadedPages(model: ModelCode, accounts: readonly AccountCode[]) {
  const api = useApi()
  return useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.notUploaded(model, account),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.objects.notUploaded({ params: { model }, query: { account }, signal }),
    })),
  })
}

/** Словарь тегов: ключ → русское имя и группа. */
export function useTags() {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.tags(),
    queryFn: ({ signal }) => api.admin.tags({ signal }),
    select: (page) => page.items,
    staleTime: 5 * 60_000,
  })
}

/** Ключ папки «Разметка на проверку»: под префиксом модели, как все её запросы. */
export const markupReviewKey = (model: ModelCode) =>
  [...queryKeys.model(model), 'markup-review'] as const

/**
 * «Разметка на проверку» (DESIGN §4.20): объекты с черновиком разметки и версии их полей —
 * массовое подтверждение несёт ровно то, что человек видел в строке.
 */
export function useMarkupReview(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: markupReviewKey(model),
    queryFn: ({ signal }) => api.markup.review({ params: { model }, signal }),
    select: (page) => page.items,
  })
}
