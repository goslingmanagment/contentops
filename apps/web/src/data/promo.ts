import type { ModelCode } from '@contentops/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/** Передача, которая готовится, опрашивается, пока видна (DESIGN §3.13, п. 8). */
const PREPARING_POLL_MS = 1_500

interface WithHandoffs {
  handoffs: readonly { state: string }[]
}

function whilePreparing(data: WithHandoffs | undefined): number | false {
  return data?.handoffs.some((handoff) => handoff.state === 'preparing') ? PREPARING_POLL_MS : false
}

export function usePromoChannels(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.promoChannels(model),
    queryFn: ({ signal }) => api.promo.channels({ params: { model }, signal }),
    select: (page) => page.items,
  })
}

export function usePromoChannel(model: ModelCode, channel: string) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.promoChannel(model, channel),
    queryFn: ({ signal }) => api.promo.channel({ params: { model, channel }, signal }),
  })
}

/**
 * Подборка со своими передачами; пока передача готовится, ход обновляется сам. Тот же кэш
 * у экрана Промо и у подборки, открытой как объект (DESIGN §4.5): `enabled` — только у промо.
 */
export function usePromoCollection(model: ModelCode, collection: string, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.promoCollection(model, collection),
    queryFn: ({ signal }) => api.promo.collection({ params: { model, collection }, signal }),
    refetchInterval: (query) => whilePreparing(query.state.data),
    enabled,
  })
}

export function usePromoHandoffs(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.promoHandoffs(model),
    queryFn: ({ signal }) => api.promo.handoffs({ params: { model }, signal }),
    select: (page) => page.items,
    refetchInterval: (query) =>
      whilePreparing(query.state.data ? { handoffs: query.state.data.items } : undefined),
  })
}

/** Подрядчики с запомненным форматом — для «Подрядчик ▾». */
export function usePromoContractors(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.promoContractors(model),
    queryFn: ({ signal }) => api.promo.contractors({ params: { model }, signal }),
    select: (page) => page.items,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/**
 * После изменения промо: канал, подборка, передачи и индекс (у подборки новые числа).
 * Обещание выполняется, когда всё перечитано: панель передачи переходит к новой
 * передаче, уже имея её в данных.
 */
export function usePromoChanged(model: ModelCode) {
  const queryClient = useQueryClient()
  return useCallback(
    async (channel: string, collection?: string) => {
      const keys = [
        queryKeys.promoChannels(model),
        queryKeys.promoChannel(model, channel),
        queryKeys.promoHandoffs(model),
        queryKeys.catalogIndex(model),
        ...(collection ? [queryKeys.promoCollection(model, collection)] : []),
      ]
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
    },
    [model, queryClient],
  )
}
