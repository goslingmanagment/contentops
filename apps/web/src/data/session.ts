import type { Role } from '@contentops/contracts'
import { useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/** Кто вошёл и какие модели ему доступны (`GET /api/v1/admin/me`). */
export function useSession() {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.session(),
    queryFn: ({ signal }) => api.admin.me({ signal }),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/** Роль вошедшего; пока сеанс не пришёл — `null`. */
export function useRole(): Role | null {
  return useSession().data?.person.role ?? null
}

/** Модели с правами, со страницами (`GET /api/v1/admin/models`). */
export function useModels() {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.models(),
    queryFn: ({ signal }) => api.admin.models({ signal }),
    select: (page) => page.items,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
