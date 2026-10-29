import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { ActionToastApi } from './action-toast-context'

/** Один вызов намерения: что сделать и ключ повтора (DESIGN §3.8). */
export interface IntentCall<Variables> {
  variables: Variables
  key: string
}

export interface IntentAttemptOptions<Variables, Result> {
  /**
   * Запрос. В хуках это `mutateAsync` наблюдателя TanStack: его обещание завершается и
   * после размонтирования источника, в отличие от колбэков `mutate()`.
   */
  execute: (call: IntentCall<Variables>) => Promise<Result>
  queryClient: Pick<QueryClient, 'invalidateQueries'>
  toast: Pick<ActionToastApi, 'showFailure'>
  /** Что не вышло, для полоски ошибки: «Не отметилось». */
  failed: string
  onSuccess?: (result: Result, variables: Variables) => void
  /** Что обновить после успеха: индекс, счётчики, список экрана. */
  invalidates?: (variables: Variables) => readonly QueryKey[]
  /** Отказ, который экран показывает сам (конфликт версии); `true` — показан. */
  handleFailure?: (error: unknown, variables: Variables) => boolean
}

/**
 * Попытка намерения, чей итог не зависит от жизни экрана-источника. Полоска «Отменить»
 * живёт дольше окна или панели, откуда пришло действие: после «Поставить» окно
 * закрывается, после `Esc` уходит полоса выделения. Поэтому сброс кэша и полоски
 * вешаются на обещание запроса, а не на колбэки `mutate()` — TanStack зовёт те, только
 * пока компонент смонтирован, и итог пропадал молча.
 *
 * «Повторить» и автоповтор после 429 идут с прежним ключом; новое нажатие — новый ключ.
 * Обещание попытки говорит, прошла ли она: поле выходит из правки только после ответа.
 */
export function intentAttempt<Variables, Result>({
  execute,
  queryClient,
  toast,
  failed,
  onSuccess,
  invalidates,
  handleFailure,
}: IntentAttemptOptions<Variables, Result>): (
  variables: Variables,
  key: string,
) => Promise<boolean> {
  const attempt = (variables: Variables, key: string): Promise<boolean> =>
    execute({ variables, key }).then(
      (result) => {
        for (const queryKey of invalidates?.(variables) ?? []) {
          void queryClient.invalidateQueries({ queryKey })
        }
        onSuccess?.(result, variables)
        return true
      },
      (error: unknown) => {
        if (!handleFailure?.(error, variables)) {
          toast.showFailure(error, {
            failed,
            retry: () => void attempt(variables, key),
            intentKey: key,
          })
        }
        return false
      },
    )
  return attempt
}
