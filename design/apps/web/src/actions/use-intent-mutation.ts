import { newIdempotencyKey } from '@contentops/contracts'
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useActionToast } from './action-toast-context'
import { type IntentCall, intentAttempt } from './intent-attempt'

interface IntentMutationOptions<Variables, Result> {
  /** Сам запрос; `idempotencyKey` передаётся в клиент API как есть. */
  run: (variables: Variables, idempotencyKey: string) => Promise<Result>
  /** Что не вышло, для полоски ошибки: «Не отметилось». */
  failed: string
  /**
   * Итог: полоска «готово», выделение новых строк. Вызывается и после того, как
   * источник размонтирован (окно закрыто, выделение снято), — локальное состояние
   * компонента тогда просто не меняется.
   */
  onSuccess?: (result: Result, variables: Variables) => void
  /** Что обновить после успеха: индекс, счётчики, список экрана. */
  invalidates?: (variables: Variables) => readonly QueryKey[]
  /**
   * Отказ, который экран показывает сам, а не полоской: конфликт версии встаёт строкой
   * на месте поля (DESIGN §3.10). Вернуть `true`, если отказ показан.
   */
  handleFailure?: (error: unknown, variables: Variables) => boolean
}

/**
 * Действие человека с ключом повтора (DESIGN §3.8): новое нажатие — новый ключ;
 * «Повторить» в полоске и автоматический повтор после 429 идут с прежним ключом.
 * Кнопка на время запроса показывает «…» (`isPending`). Итог не теряется, если источник
 * размонтирован до ответа или «Отменить» нажато уже после (см. `intentAttempt`).
 */
export function useIntentMutation<Variables, Result>({
  run,
  failed,
  onSuccess,
  invalidates,
  handleFailure,
}: IntentMutationOptions<Variables, Result>) {
  const toast = useActionToast()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ variables, key }: IntentCall<Variables>) => run(variables, key),
  })
  const { mutateAsync } = mutation

  const attempt = useMemo(
    () =>
      intentAttempt({
        execute: mutateAsync,
        queryClient,
        toast,
        failed,
        onSuccess,
        invalidates,
        handleFailure,
      }),
    [failed, handleFailure, invalidates, mutateAsync, onSuccess, queryClient, toast],
  )

  const start = useCallback(
    (variables: Variables) => attempt(variables, newIdempotencyKey()),
    [attempt],
  )

  return { start, isPending: mutation.isPending }
}
