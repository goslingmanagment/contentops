import type {
  AddRevisionCommand,
  ItemId,
  Order,
  OrderDelivery,
  RevisionBasis,
} from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useOrderSaved } from '@/data/orders'
import { useCurrentModel } from '@/shell/model/model-context'

interface OrderIntent {
  order: Order
  /** Отмена прошлого действия из полоски: своя полоска без повторной «Отменить». */
  undo?: boolean
}

interface RevisionIntent extends OrderIntent {
  revision: string
}

interface CompleteIntent extends RevisionIntent {
  basis: RevisionBasis
}

interface LinkIntent extends OrderIntent {
  item: ItemId
}

interface UnlinkIntent extends OrderIntent {
  delivery: OrderDelivery
}

interface AddRevisionIntent extends OrderIntent {
  body: AddRevisionCommand
  /** Форма правки закрывается только после ответа сервера. */
  onSaved: () => void
}

/**
 * Команды заказа (DESIGN §4.16, §3.8): каждое нажатие — своё намерение со своим ключом
 * повтора; полоска — только после ответа. Что можно вернуть, возвращается из полоски;
 * закрытие заказа отменить нельзя — причина, почему нельзя закрыть, видна до нажатия.
 * Заказ передаётся в каждую команду: те же команды служат и панели, и меню строки.
 */
export function useOrderActions() {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const saved = useOrderSaved(model)
  const paramsOf = (order: Order) => ({ model, order: order.id })

  const addRevision = useIntentMutation<AddRevisionIntent, Order>({
    failed: 'Правка не добавилась',
    run: ({ order, body }, key) =>
      api.orders.addRevision({ params: paramsOf(order), body, idempotencyKey: key }),
    onSuccess: (next, { onSaved }) => {
      saved(next)
      onSaved()
      toast.show({ message: 'Правка добавлена' })
    },
  })

  const complete = useIntentMutation<CompleteIntent, Order>({
    failed: 'Не отметилось',
    run: ({ order, revision, basis }, key) =>
      api.orders.completeRevision({
        params: { ...paramsOf(order), revision },
        body: { basis },
        idempotencyKey: key,
      }),
    onSuccess: (next, { revision, undo }) => {
      saved(next)
      toast.show(
        undo
          ? { message: 'Отменено' }
          : {
              message: 'Правка выполнена',
              action: {
                label: 'Отменить',
                onSelect: () => reopen.start({ order: next, revision, undo: true }),
              },
              undoable: true,
            },
      )
    },
  })

  const reopen = useIntentMutation<RevisionIntent, Order>({
    failed: 'Не переоткрылась',
    run: ({ order, revision }, key) =>
      api.orders.reopenRevision({
        params: { ...paramsOf(order), revision },
        idempotencyKey: key,
      }),
    onSuccess: (next, { order, revision, undo }) => {
      saved(next)
      const basis = order.revisions.find((item) => item.id === revision)?.done?.basis ?? 'checked'
      toast.show(
        undo
          ? { message: 'Отменено' }
          : {
              message: 'Правка снова открыта',
              action: {
                label: 'Отменить',
                onSelect: () => complete.start({ order: next, revision, basis, undo: true }),
              },
              undoable: true,
            },
      )
    },
  })

  const link = useIntentMutation<LinkIntent, Order>({
    failed: 'Сдача не привязалась',
    run: ({ order, item }, key) =>
      api.orders.linkDelivery({
        params: paramsOf(order),
        body: { item_id: item },
        idempotencyKey: key,
      }),
    onSuccess: (next, { item, undo }) => {
      saved(next)
      const delivery = next.deliveries.find((candidate) => candidate.item_id === item)
      if (undo || !delivery) {
        toast.show({ message: undo ? 'Отменено' : `Сдача ${item} привязана` })
        return
      }
      toast.show({
        message: `Сдача ${item} привязана`,
        action: {
          label: 'Отменить',
          onSelect: () => unlink.start({ order: next, delivery, undo: true }),
        },
        undoable: true,
      })
    },
  })

  const unlink = useIntentMutation<UnlinkIntent, Order>({
    failed: 'Сдача не отвязалась',
    run: ({ order, delivery }, key) =>
      api.orders.unlinkDelivery({
        params: { ...paramsOf(order), delivery: delivery.id },
        idempotencyKey: key,
      }),
    onSuccess: (next, { delivery, undo }) => {
      saved(next)
      toast.show(
        undo
          ? { message: 'Отменено' }
          : {
              message: `Сдача ${delivery.item_id} отвязана`,
              action: {
                label: 'Вернуть',
                onSelect: () => link.start({ order: next, item: delivery.item_id, undo: true }),
              },
              undoable: true,
            },
      )
    },
  })

  const close = useIntentMutation<OrderIntent, Order>({
    failed: 'Заказ не закрылся',
    run: ({ order }, key) => api.orders.close({ params: paramsOf(order), idempotencyKey: key }),
    onSuccess: (next) => {
      saved(next)
      toast.show({ message: `Заказ закрыт · ${next.title}` })
    },
  })

  return {
    addRevision: (order: Order, body: AddRevisionCommand, onSaved: () => void) =>
      addRevision.start({ order, body, onSaved }),
    addingRevision: addRevision.isPending,
    complete: (order: Order, revision: string, basis: RevisionBasis) =>
      complete.start({ order, revision, basis }),
    completing: complete.isPending,
    reopen: (order: Order, revision: string) => reopen.start({ order, revision }),
    reopening: reopen.isPending,
    link: (order: Order, item: ItemId) => link.start({ order, item }),
    linking: link.isPending,
    unlink: (order: Order, delivery: OrderDelivery) => unlink.start({ order, delivery }),
    unlinking: unlink.isPending,
    close: (order: Order) => close.start({ order }),
    closing: close.isPending,
  }
}

export type OrderActions = ReturnType<typeof useOrderActions>
