import type { HubOrder, HubOrderList, ModelCode } from '@contentops/contracts'
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/**
 * Заказы Hub в производстве (пакет N, 12.11.2026): дом заказа — Hub, ContentOps показывает
 * последнее чтение Hub с файлами, что держит для заказа. Пока Hub читается или сдача ещё не
 * дошла до Hub, список перечитывается чаще — иначе раз в минуту.
 */
const BUSY_MS = 5_000
const IDLE_MS = 60_000

function waits(list: HubOrderList | undefined): boolean {
  return (
    list !== undefined && (list.refreshing || list.items.some((order) => order.pending_reports > 0))
  )
}

export function useHubOrderList(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.hubOrders(model),
    queryFn: ({ signal }) => api.hubOrders.list({ params: { model }, signal }),
    refetchInterval: (query) => (waits(query.state.data) ? BUSY_MS : IDLE_MS),
  })
}

function orderFromList(queryClient: QueryClient, model: ModelCode, code: string) {
  const key = queryKeys.hubOrders(model)
  const found = queryClient
    .getQueryData<HubOrderList>(key)
    ?.items.find((order) => order.code === code)
  return found ? { order: found, updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt } : null
}

/** Один заказ Hub по коду; из пришедшего списка панель открывается сразу. */
export function useHubOrder(model: ModelCode, code: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.hubOrder(model, code),
    queryFn: ({ signal }) => api.hubOrders.get({ params: { model, code }, signal }),
    initialData: () => orderFromList(queryClient, model, code)?.order,
    initialDataUpdatedAt: () => orderFromList(queryClient, model, code)?.updatedAt,
    refetchInterval: (query) => ((query.state.data?.pending_reports ?? 0) > 0 ? BUSY_MS : false),
  })
}

/** После ответа сервера: заказ — в кэш как есть, список и индекс каталога — перечитать. */
export function useHubOrderSaved(model: ModelCode) {
  const queryClient = useQueryClient()
  return useCallback(
    (order: HubOrder) => {
      queryClient.setQueryData(queryKeys.hubOrder(model, order.code), order)
      void queryClient.invalidateQueries({ queryKey: queryKeys.hubOrders(model) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogIndex(model) })
    },
    [model, queryClient],
  )
}
