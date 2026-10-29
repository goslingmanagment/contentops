import {
  type ConflictDetails,
  ConflictDetailsSchema,
  isApiError,
  newIdempotencyKey,
  type Order,
  type UpdateOrderCommand,
} from '@contentops/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { type IntentCall, intentAttempt } from '@/actions/intent-attempt'
import { useApi } from '@/data/api-session'
import { useOrderReload, useOrderSaved } from '@/data/orders'
import { useCurrentModel } from '@/shell/model/model-context'

/** Какое поле правится: к нему встаёт строка конфликта. */
export type OrderFieldKey =
  | 'buyer'
  | 'account'
  | 'brief'
  | 'duration_raw'
  | 'wants'
  | 'deadline'
  | 'fan_name'

interface SaveRequest {
  field: OrderFieldKey
  patch: UpdateOrderCommand
  /** Прежние значения — для «Отменить» в полоске. */
  previous: UpdateOrderCommand
  version: number
  /** Поле выходит из правки только после ответа сервера. */
  onSaved?: () => void
}

export interface OrderConflict {
  field: OrderFieldKey
  details: ConflictDetails
  request: SaveRequest
}

function conflictOf(error: unknown): ConflictDetails | null {
  if (!isApiError(error) || error.status !== 412) return null
  return ConflictDetailsSchema.safeParse(error.body.details).data ?? null
}

/**
 * Правка поля заказа на месте (DESIGN §4.16, §3.10): запрос несёт версию записи
 * (`If-Match`). Если заказ успели изменить (412), у поля встаёт строка конфликта, а
 * черновик человека остаётся: «Показать её вариант» или «Оставить мой».
 */
export function useOrderUpdate(order: Order) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const queryClient = useQueryClient()
  const saved = useOrderSaved(model)
  const reload = useOrderReload(model)
  const [conflict, setConflict] = useState<OrderConflict | null>(null)
  const mutation = useMutation({
    mutationFn: ({ variables: request, key }: IntentCall<SaveRequest>) =>
      api.orders.update({
        params: { model, order: order.id },
        body: request.patch,
        ifMatch: request.version,
        idempotencyKey: key,
      }),
  })
  const { mutateAsync } = mutation

  // Итог — на обещании запроса: «Сохранено · Отменить» и отмена работают, даже если
  // панель заказа уже закрыта (см. intentAttempt).
  const send = useMemo(() => {
    const attempt = intentAttempt<SaveRequest, Order>({
      execute: mutateAsync,
      queryClient,
      toast,
      failed: 'Не сохранилось',
      onSuccess: (next, request) => {
        saved(next)
        setConflict(null)
        request.onSaved?.()
        toast.show({
          message: 'Сохранено',
          action: {
            label: 'Отменить',
            onSelect: () =>
              attempt(
                {
                  field: request.field,
                  patch: request.previous,
                  previous: request.patch,
                  version: next.version,
                },
                newIdempotencyKey(),
              ),
          },
          undoable: true,
        })
      },
      handleFailure: (error, request) => {
        const details = conflictOf(error)
        if (!details) return false
        setConflict({ field: request.field, details, request })
        return true
      },
    })
    return attempt
  }, [mutateAsync, queryClient, saved, toast])

  const save = useCallback(
    (request: Omit<SaveRequest, 'version'>) =>
      send({ ...request, version: order.version }, newIdempotencyKey()),
    [send, order.version],
  )

  /** «Оставить мой»: тот же черновик поверх новой версии — это новое намерение, новый ключ. */
  const keepMine = useCallback(() => {
    if (!conflict) return
    send({ ...conflict.request, version: conflict.details.current_version }, newIdempotencyKey())
  }, [conflict, send])

  /** «Показать её вариант»: черновик отбрасывается, заказ перечитывается. */
  const showTheirs = useCallback(() => {
    setConflict(null)
    void reload(order.id)
  }, [order.id, reload])

  return { save, pending: mutation.isPending, conflict, keepMine, showTheirs }
}

export type OrderUpdate = ReturnType<typeof useOrderUpdate>
