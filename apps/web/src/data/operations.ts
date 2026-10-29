import type { ModelCode } from '@contentops/contracts'
import { useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/** Долгие операции в лотке опрашиваются раз в 1,5 с, пока идут (DESIGN §3.13, п. 8). */
const OPERATION_POLL_MS = 1_500

export function useOperation(model: ModelCode, operation: string) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.operation(model, operation),
    queryFn: ({ signal }) => api.operations.get({ params: { model, operation }, signal }),
    refetchInterval: (query) =>
      query.state.data?.state === 'running' || query.state.data === undefined
        ? OPERATION_POLL_MS
        : false,
  })
}
