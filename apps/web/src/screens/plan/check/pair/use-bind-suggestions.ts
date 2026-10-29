import {
  type Account,
  type CatalogEntry,
  type HubPost,
  type ModelCode,
  mskDate,
  notUploadedStatus,
} from '@contentops/contracts'
import { useMemo } from 'react'
import { pageSummaryOf, useCatalogIndex, usePageSummaries } from '@/data/catalog'
import { useCatalogSearch } from '@/data/catalog-search'

const LIMIT = 6

export interface BindSuggestions {
  /** «Ещё не залито на Fansly 1 · по времени»; при поиске — `null`. */
  title: string | null
  /** `undefined` — индекс ещё грузится. */
  items: readonly CatalogEntry[] | undefined
}

/**
 * Что предложить для поста без плана (DESIGN §4.15): без запроса — ещё не залитое на эту
 * страницу, ближайшее по времени к посту; с запросом — поиск по индексу в браузере.
 */
export function useBindSuggestions(
  model: ModelCode,
  account: Account,
  post: HubPost | undefined,
  query: string,
): BindSuggestions {
  const index = useCatalogIndex(model).data
  const summaries = usePageSummaries(model).data
  const search = useCatalogSearch(model)
  return useMemo(() => {
    if (query.trim()) {
      return { title: null, items: search?.find(query, LIMIT) }
    }
    const title = `Ещё не залито на ${account.label} · по времени`
    if (!index || !summaries) {
      return { title, items: undefined }
    }
    const postDate = post ? mskDate(post.post_at) : null
    const items = index.items
      .filter(
        (entry) =>
          (postDate === null || entry.arrived_on <= postDate) &&
          notUploadedStatus(
            entry,
            pageSummaryOf(summaries, entry.id, account.code),
            account.platform,
          ) === 'not_uploaded',
      )
      .sort((left, right) => right.arrived_on.localeCompare(left.arrived_on))
      .slice(0, LIMIT)
    return { title, items }
  }, [account, index, post, query, search, summaries])
}
