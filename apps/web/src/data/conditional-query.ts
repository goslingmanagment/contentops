import type { ConditionalResult } from '@contentops/contracts'
import { type QueryKey, useQuery, useQueryClient } from '@tanstack/react-query'

/** Индекс модели опрашивается условным запросом раз в 60 с и при возврате на вкладку. */
const INDEX_POLL_MS = 60_000

export interface VersionedView {
  etag: string | null
}

interface ConditionalQueryOptions<Raw, View extends VersionedView> {
  queryKey: QueryKey
  fetch: (etag: string | null, signal: AbortSignal) => Promise<ConditionalResult<Raw>>
  toView: (raw: Raw, etag: string | null) => View
  enabled?: boolean
}

/**
 * Ресурс индекса со своим ETag (DESIGN §3.13, п. 1): повторный запрос несёт
 * `If-None-Match`, ответ 304 оставляет прежние данные тем же объектом — экран не
 * перерисовывается.
 */
export function useConditionalQuery<Raw, View extends VersionedView>({
  queryKey,
  fetch,
  toView,
  enabled = true,
}: ConditionalQueryOptions<Raw, View>) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<View>(queryKey)
      const result = await fetch(previous?.etag ?? null, signal)
      if (result.status === 'ok') {
        return toView(result.data, result.etag)
      }
      if (previous) {
        return previous
      }
      // 304 без прежних данных: такого ответа сервер дать не должен, просим заново.
      const fresh = await fetch(null, signal)
      if (fresh.status !== 'ok') {
        throw new Error('Сервер ответил 304 на запрос без версии')
      }
      return toView(fresh.data, fresh.etag)
    },
    structuralSharing: false,
    staleTime: INDEX_POLL_MS,
    refetchInterval: INDEX_POLL_MS,
    refetchOnWindowFocus: true,
  })
}
