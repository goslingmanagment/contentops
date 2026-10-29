import { type CatalogEntry, type Model, mskDate } from '@contentops/contracts'
import { useMemo } from 'react'
import { useClock } from '@/data/api-session'
import {
  useCatalogIndex,
  useDeletedItems,
  usePageSummaries,
  useRecent,
  useTags,
} from '@/data/catalog'
import { hubLineOf, useIntegrations } from '@/data/integrations'
import { useOrderList } from '@/data/orders'
import { notUploadedByPage } from '../shared/not-uploaded-index'
import { hubFolderNoteText } from './hub-note'
import { buildLibraryFolders } from './library-folders'
import type { RecentObject } from './recent-strip'

/**
 * Всё, что нужно корню Библиотеки, из индекса модели в браузере (DESIGN §4.1, агент):
 * отдельного маршрута нет — счётчики и мозаики считаются из индекса, «Недавние» — свой
 * запрос.
 */
export function useLibraryRootData(model: Model) {
  const index = useCatalogIndex(model.code)
  const summaries = usePageSummaries(model.code)
  const recent = useRecent(model.code)
  const orders = useOrderList(model.code, 'open')
  const deleted = useDeletedItems(model.code)
  const integrations = useIntegrations()
  const tags = useTags()
  const clock = useClock()
  const today = mskDate(clock.now())

  // Фраза пересчитывается, когда пришли новые состояния интеграций, а не на каждый рендер.
  const hubLine = useMemo(
    () => (integrations.data ? hubLineOf(integrations.data, model.code, clock.now()) : null),
    [integrations.data, model.code, clock],
  )

  const hubNote = useMemo(
    () =>
      hubLine && integrations.data
        ? { line: hubLine, short: hubFolderNoteText(hubLine, integrations.data, model.accounts) }
        : null,
    [hubLine, integrations.data, model.accounts],
  )

  const notUploaded = useMemo(
    () =>
      index.data && summaries.data
        ? notUploadedByPage(index.data.items, summaries.data, model.accounts)
        : null,
    [index.data, summaries.data, model.accounts],
  )

  const overdueOrders = orders.data?.overdue_count ?? 0
  const markupReview =
    integrations.data?.some(
      (integration) => integration.kind === 'ai' && integration.state === 'working',
    ) ?? false
  const folders = useMemo(
    () =>
      index.data
        ? buildLibraryFolders({
            items: index.data.items,
            today,
            overdueOrders,
            notUploaded,
            pageCount: model.accounts.length,
            hubNote,
            markupReview,
          })
        : null,
    [index.data, today, overdueOrders, notUploaded, model.accounts.length, hubNote, markupReview],
  )

  const recentObjects = useMemo<RecentObject[]>(
    () =>
      (recent.data ?? []).flatMap((item) => {
        const entry = index.data?.byId.get(item.item_id)
        return entry ? [{ entry, recent: item }] : []
      }),
    [recent.data, index.data],
  )

  const collections = useMemo<CatalogEntry[]>(
    () =>
      (index.data?.items ?? [])
        .filter((entry) => entry.type === 'promo')
        .sort((left, right) => right.arrived_on.localeCompare(left.arrived_on)),
    [index.data],
  )

  return {
    index,
    summaries,
    recent,
    deletedCount: deleted.data?.length ?? null,
    tags: tags.data,
    hubLine,
    notUploaded,
    folders,
    recentObjects,
    collections,
  }
}
