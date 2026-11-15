import type { ModelCode, PublicationWindow } from '@contentops/contracts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/**
 * «Публикации» (план продуктов §2.4, пакет C2): публикации Hub, прочитанные от имени вошедшего человека. Hub сам
 * двигает статусы (поставлен, вышел), поэтому лента перечитывается раз в минуту.
 */
const MINUTE = 60_000

export interface PublicationsQuery {
  window: PublicationWindow
  status?: string | undefined
  page?: string | undefined
}

export function usePublicationsFeed(model: ModelCode, search: PublicationsQuery) {
  const api = useApi()
  const key = { window: search.window, status: search.status, page: search.page }
  return useQuery({
    queryKey: queryKeys.publications(model, key),
    queryFn: ({ signal }) =>
      api.publications.feed({
        params: { model },
        query: {
          window: search.window,
          ...(search.status ? { status: search.status } : {}),
          ...(search.page ? { page: search.page } : {}),
        },
        signal,
      }),
    refetchInterval: MINUTE,
    placeholderData: keepPreviousData,
  })
}

export function usePublicationCard(model: ModelCode, id: number) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.publication(model, id),
    queryFn: ({ signal }) =>
      api.publications.card({ params: { model, publication: String(id) }, signal }),
    refetchInterval: MINUTE,
  })
}
