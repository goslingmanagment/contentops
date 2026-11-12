import { isApiError, type SignInCommand } from '@contentops/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isNetworkFailure } from '@/actions/failure-message'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

/** Что сказать под формой: без подробностей, какой из двух не подошёл (§4.21). */
export function signInFailure(error: unknown): string {
  if (isApiError(error) && error.status === 401) {
    return 'Логин или пароль не подходят'
  }
  if (isApiError(error) && error.status === 429) {
    return error.message
  }
  if (isNetworkFailure(error) || (isApiError(error) && error.status === 503)) {
    return 'Не вошли: нет связи'
  }
  return 'Не вошли: сбой'
}

/**
 * Вход (`POST /api/v1/auth/sign-in`). После ответа весь кэш перечитывается: всё, что
 * успело ответить 401, запрашивается заново уже в сеансе.
 */
export function useSignIn(onSignedIn: () => void) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SignInCommand) => api.auth.signIn({ body }),
    onSuccess: async () => {
      await queryClient.resetQueries()
      onSignedIn()
    },
  })
}

/**
 * Предлагает ли этот адрес «Войти через хаб» (`GET /api/v1/auth/methods`): только публичное
 * имя, где хаб настроен; VPN и tailnet — только пароль. `known` — ответ пришёл (или не
 * пришёл совсем: тогда пароль).
 */
export function useHubSignIn(): { offered: boolean; known: boolean } {
  const api = useApi()
  const methods = useQuery({
    queryKey: queryKeys.signInMethods(),
    queryFn: ({ signal }) => api.auth.signInMethods({ signal }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  return { offered: methods.data?.hub === true, known: !methods.isPending }
}

/** Адрес входа через хаб: сервер уводит в хаб и возвращает туда, откуда пришли. */
export function hubSignInHref(from: string | undefined): string {
  return from && from !== '/'
    ? `/auth/hub/start?${new URLSearchParams({ next: from })}`
    : '/auth/hub/start'
}

/** Что сказать, когда вход через хаб не открыл сессию. */
export const HUB_REFUSAL: Record<'failed' | 'unreachable', string> = {
  failed: 'Не вошли через хаб: попробуйте ещё раз',
  unreachable: 'Не вошли через хаб: нет связи с хабом',
}
