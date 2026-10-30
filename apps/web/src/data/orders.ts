import type { ModelCode, Order, OrderList, OrderTab } from '@contentops/contracts'
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

export type { OrderTab }

const ORDER_TABS: readonly OrderTab[] = ['open', 'closed', 'cancelled']

/** Открытых заказов — десятки: список приходит целиком, группы строятся на экране. */
const WHOLE_LIST = 500

/**
 * Заказы кастомов: «Открытые», «Закрытые» или «Снятые», с числом просроченных; `q` ищет
 * сразу во всех вкладках (DESIGN §4.16).
 */
export function useOrderList(model: ModelCode, tab: OrderTab = 'open', q?: string) {
  const api = useApi()
  const search = q?.trim() || undefined
  return useQuery({
    queryKey: search ? [...queryKeys.orders(model, tab), search] : queryKeys.orders(model, tab),
    queryFn: ({ signal }) =>
      api.orders.list({
        params: { model },
        query: { tab, limit: WHOLE_LIST, ...(search ? { q: search } : {}) },
        signal,
      }),
  })
}

/** Заказ из уже пришедшего списка: панель открывается сразу, без ожидания (§3.13). */
function orderFromLists(queryClient: QueryClient, model: ModelCode, id: string) {
  for (const tab of ORDER_TABS) {
    const key = queryKeys.orders(model, tab)
    const found = queryClient.getQueryData<OrderList>(key)?.items.find((item) => item.id === id)
    if (found) {
      return { order: found, updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt }
    }
  }
  return null
}

/** Один заказ со своей версией записи — для правок с `If-Match`. */
export function useOrder(model: ModelCode, order: string) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.order(model, order),
    queryFn: ({ signal }) => api.orders.get({ params: { model, order }, signal }),
    initialData: () => orderFromLists(queryClient, model, order)?.order,
    initialDataUpdatedAt: () => orderFromLists(queryClient, model, order)?.updatedAt,
  })
}

/**
 * После ответа сервера: заказ кладётся в кэш как есть, списки обеих вкладок и индекс
 * каталога (у сдачи меняется заказ) перечитываются.
 */
export function useOrderSaved(model: ModelCode) {
  const queryClient = useQueryClient()
  return useCallback(
    (order: Order) => {
      queryClient.setQueryData(queryKeys.order(model, order.id), order)
      for (const tab of ORDER_TABS) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.orders(model, tab) })
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogIndex(model) })
    },
    [model, queryClient],
  )
}

/** «Показать её вариант» после 412: прежний черновик отбрасывается, заказ перечитывается. */
export function useOrderReload(model: ModelCode) {
  const queryClient = useQueryClient()
  return useCallback(
    (order: string) => queryClient.invalidateQueries({ queryKey: queryKeys.order(model, order) }),
    [model, queryClient],
  )
}

/** Разбор карточки — чистая функция сервера, поэтому живёт как запрос по тексту. */
const orderCardKey = (model: ModelCode, text: string, url: string | null) =>
  [...queryKeys.model(model), 'order-card', text, url] as const

/**
 * «Вставить текст карточки → поля разобраны» (DESIGN §4.16): сервер разбирает карточку
 * теми же правилами, что и у агента заказов. Пустой текст не разбирается.
 */
export function useOrderCardParse(model: ModelCode, text: string, url: string | null) {
  const api = useApi()
  return useQuery({
    queryKey: orderCardKey(model, text, url),
    queryFn: ({ signal }) =>
      api.orders.parseCard({
        params: { model },
        body: { card_text: text, message_url: url },
        signal,
      }),
    enabled: text.trim().length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/**
 * Заказ заведён: списки перечитываются; группа «Приехало», из которой открыто окно, —
 * тоже, чтобы в «Какой заказ?» появился новый заказ.
 */
export function useOrderCreated(model: ModelCode) {
  const queryClient = useQueryClient()
  return useCallback(
    (order: Order, inboxGroupId?: string) => {
      queryClient.setQueryData(queryKeys.order(model, order.id), order)
      for (const tab of ORDER_TABS) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.orders(model, tab) })
      }
      // Кандидаты «Какой заказ?» живут в самой группе, а группа — в списке «Приехало».
      if (inboxGroupId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(model, 'active') })
      }
    },
    [model, queryClient],
  )
}
