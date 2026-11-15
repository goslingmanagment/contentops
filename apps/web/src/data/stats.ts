import type { ModelCode, StatsDays } from '@contentops/contracts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/**
 * «Статистика» (план продуктов §2.4, пакет C2): цифры Fansly одной страницы модели, прочитанные Hub, — от имени
 * вошедшего человека. Hub обходит медиа раз в несколько часов, поэтому экран сам не перечитывается.
 */
export function useStatsScreen(model: ModelCode, page: string | undefined, days: StatsDays) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.stats(model, page ?? null, days),
    queryFn: ({ signal }) =>
      api.stats.screen({
        params: { model },
        query: { days, ...(page ? { page } : {}) },
        signal,
      }),
    placeholderData: keepPreviousData,
  })
}

export function useStatsMedia(model: ModelCode, media: string, page: string, days: StatsDays) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.statsMedia(model, media, page, days),
    queryFn: ({ signal }) =>
      api.stats.media({ params: { model, media }, query: { page, days }, signal }),
  })
}
