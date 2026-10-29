import {
  type ConflictDetails,
  ConflictDetailsSchema,
  formatAgo,
  type Instant,
  isApiError,
  newIdempotencyKey,
  pastVerb,
} from '@contentops/contracts'
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useClock } from '@/data/api-session'
import { type IntentCall, intentAttempt } from './intent-attempt'

/** Правка и версия записи, на которой она основана (§3.10). */
interface SaveCall<Variables> {
  variables: Variables
  version: number
}

export interface VersionConflict<Variables = unknown> {
  /** «Диана изменила заметку 1 мин назад». */
  message: string
  /** «Показать её вариант» / «Показать его вариант». */
  theirsLabel: string
  /** Что лежит на сервере сейчас, если сервер это прислал. */
  currentValue: unknown
  /** Своя правка, которую отклонил сервер: «Оставить мой» отправит её поверх новой версии. */
  mine: Variables
}

interface VersionedSaveOptions<Variables, Result> {
  /** Запрос с `If-Match`: версия и ключ повтора передаются в клиент API как есть. */
  run: (variables: Variables, version: number, key: string) => Promise<Result>
  /**
   * Что меняли, в винительном падеже для строки конфликта: «заметку», «норму», «права»;
   * функция — если слово зависит от поля («название», «теги»).
   */
  subject: string | ((variables: Variables) => string)
  /** Что не вышло, для полоски ошибки: «Не сохранилось». */
  failed: string
  /** Что перечитать после успеха и после «Показать её вариант». */
  invalidates: readonly QueryKey[]
  onSuccess?: (result: Result, variables: Variables) => void
}

/**
 * Строка конфликта §3.10 из ответа 412: кто, что и когда. Род глагола и «её/его» — из
 * `changed_by_gender` сервера; без него — мужской род глагола и «Показать другой вариант»,
 * по имени род не угадывается.
 */
export function conflictLine(
  details: ConflictDetails,
  subject: string,
  now: Instant,
): Pick<VersionConflict, 'message' | 'theirsLabel'> {
  const gender = details.changed_by_gender ?? null
  return {
    message: `${details.changed_by} ${pastVerb('изменил', gender)} ${subject} ${formatAgo(details.changed_at, now)}`,
    theirsLabel:
      gender === 'f'
        ? 'Показать её вариант'
        : gender === 'm'
          ? 'Показать его вариант'
          : 'Показать другой вариант',
  }
}

/**
 * Сохранение правки с `If-Match` (DESIGN §3.10, §3.13, SPEC §11.2) — одно на все поля:
 * черновик «Приехало», разметку объекта, заметки, нормы, права. «Сохранено» — только после
 * ответа сервера; 412 не сбрасывает ввод и не уходит в полоску, а становится строкой
 * конфликта на месте поля — «Диана изменила … · Показать её вариант · Оставить мой».
 * «Оставить мой» отправляет правку поверх версии из ответа 412 новым намерением, без
 * перечитывания; его отказы, как и остальные, — полоской §3.8 с повтором тем же ключом.
 * Итог не теряется, если поле уже закрыто (см. `intentAttempt`).
 */
export function useVersionedSave<Variables, Result>({
  run,
  subject,
  failed,
  invalidates,
  onSuccess,
}: VersionedSaveOptions<Variables, Result>) {
  const toast = useActionToast()
  const clock = useClock()
  const queryClient = useQueryClient()
  const [conflict, setConflict] = useState<{
    view: VersionConflict<Variables>
    call: SaveCall<Variables>
    currentVersion: number
  } | null>(null)

  const mutation = useMutation({
    mutationFn: ({ variables: call, key }: IntentCall<SaveCall<Variables>>) =>
      run(call.variables, call.version, key),
  })
  const { mutateAsync } = mutation

  const refresh = useCallback(() => {
    for (const queryKey of invalidates) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }, [invalidates, queryClient])

  const send = useMemo(
    () =>
      intentAttempt<SaveCall<Variables>, Result>({
        execute: mutateAsync,
        queryClient,
        toast,
        failed,
        invalidates: () => invalidates,
        onSuccess: (result, call) => onSuccess?.(result, call.variables),
        handleFailure: (error, call) => {
          const details =
            isApiError(error) && error.status === 412
              ? ConflictDetailsSchema.safeParse(error.body.details).data
              : undefined
          if (!details) {
            return false
          }
          const what = typeof subject === 'function' ? subject(call.variables) : subject
          setConflict({
            call,
            currentVersion: details.current_version,
            view: {
              ...conflictLine(details, what, clock.now()),
              currentValue: details.current_value,
              mine: call.variables,
            },
          })
          return true
        },
      }),
    [clock, failed, invalidates, mutateAsync, onSuccess, queryClient, subject, toast],
  )

  const attempt = useCallback(
    (call: SaveCall<Variables>) => {
      setConflict(null)
      return send(call, newIdempotencyKey())
    },
    [send],
  )

  /** `true` — сервер принял правку. */
  const save = useCallback(
    (variables: Variables, version: number) => attempt({ variables, version }),
    [attempt],
  )

  /** «Оставить мой»: своя правка (или то, что в поле сейчас) поверх текущей версии. */
  const keepMine = useCallback(
    (variables?: Variables) =>
      conflict
        ? attempt({
            variables: variables ?? conflict.call.variables,
            version: conflict.currentVersion,
          })
        : Promise.resolve(false),
    [attempt, conflict],
  )

  /** «Показать её вариант»: свежая запись с сервера, своя правка отбрасывается. */
  const showTheirs = useCallback(() => {
    setConflict(null)
    refresh()
  }, [refresh])

  /** Строку конфликта убрать без запроса: запись сменилась (другая группа в панели). */
  const dismissConflict = useCallback(() => setConflict(null), [])

  return {
    save,
    isPending: mutation.isPending,
    conflict: conflict?.view ?? null,
    keepMine,
    showTheirs,
    dismissConflict,
  }
}
