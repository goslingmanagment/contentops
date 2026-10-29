import type { ApiClient, ItemDetail, ItemId, ModelCode } from '@contentops/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

function itemQuery(api: ApiClient, model: ModelCode, id: ItemId) {
  return {
    queryKey: queryKeys.item(model, id),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.objects.get({ params: { model, id }, signal }),
  }
}

/** Карточка объекта целиком: файлы, размещение, разметка, происхождение, история. */
export function useItem(model: ModelCode, id: ItemId, options: { enabled?: boolean } = {}) {
  const api = useApi()
  return useQuery({ ...itemQuery(api, model, id), enabled: options.enabled ?? true })
}

/**
 * Карточку объекта можно начать читать до перехода (DESIGN §3.13): по наведению, фокусу
 * и первому щелчку плитки. Свежая карточка в кэше не перечитывается.
 */
export function usePrefetchItem(model: ModelCode) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useCallback(
    (id: ItemId) => void queryClient.prefetchQuery(itemQuery(api, model, id)),
    [api, model, queryClient],
  )
}

/**
 * Ответ сервера на правку объекта — новая карточка: она сразу встаёт в кэш, а индекс
 * модели и сводка по страницам перечитываются (плитки, чипы, «где залито» в разделах).
 * Ответы быстрых правок подряд приходят в любом порядке: карточка старее той, что уже
 * на экране, не ставится.
 */
export function useItemWriter(model: ModelCode) {
  const queryClient = useQueryClient()
  return useCallback(
    (detail: ItemDetail) => {
      queryClient.setQueryData<ItemDetail>(queryKeys.item(model, detail.entry.id), (current) =>
        current && current.version > detail.version ? current : detail,
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogIndex(model) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.pageSummaries(model) })
    },
    [model, queryClient],
  )
}

/** Что перечитать после действия, которое сервер доводит сам (202, новый объект). */
export function itemQueryKeys(model: ModelCode, id: ItemId) {
  return [
    queryKeys.item(model, id),
    queryKeys.catalogIndex(model),
    queryKeys.pageSummaries(model),
  ] as const
}
