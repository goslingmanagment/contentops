import type { ModelCode, ModelCounters } from '@contentops/contracts'
import { useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/** Счётчики колонки опрашиваются одним запросом раз в 30 с; на скрытой вкладке опрос стоит. */
const COUNTERS_POLL_MS = 30_000

export function useCounters() {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.counters(),
    queryFn: ({ signal }) => api.admin.counters({ signal }),
    refetchInterval: COUNTERS_POLL_MS,
    staleTime: COUNTERS_POLL_MS,
  })
}

export function useModelCounters(model: ModelCode): ModelCounters | undefined {
  return useCounters().data?.models.find((counters) => counters.model === model)
}
