import { isApiError, type SignInCommand } from '@contentops/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isNetworkFailure } from '@/actions/failure-message'
import { useApi } from '@/data/api-session'

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
