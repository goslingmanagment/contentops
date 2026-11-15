import type {
  HubOrder,
  HubOrderFile,
  HubOrderList,
  HubOrderStepCommand,
  ItemId,
} from '@contentops/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useHubOrderSaved } from '@/data/hub-orders'
import { queryKeys } from '@/data/query-keys'
import { useCurrentModel } from '@/shell/model/model-context'

interface LinkIntent {
  order: HubOrder
  item: ItemId
  undo?: boolean
}

interface UnlinkIntent {
  order: HubOrder
  file: HubOrderFile
  reason: string
  undo?: boolean
}

/**
 * Команды заказа Hub (пакет N): файл к заказу и обратно. Hub узнаёт о сдаче через очередь
 * отправки: полоска говорит «привязана», а «сдано» ставит только Hub — карточка показывает,
 * дошла ли сдача.
 */
export function useHubOrderActions() {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const saved = useHubOrderSaved(model)
  const queryClient = useQueryClient()

  const link = useIntentMutation<LinkIntent, HubOrder>({
    failed: 'Файл не привязался',
    run: ({ order, item }, key) =>
      api.hubOrders.linkDelivery({
        params: { model, code: order.code },
        body: { item_id: item },
        idempotencyKey: key,
      }),
    onSuccess: (next, { item, undo }) => {
      saved(next)
      const file = next.files
        .filter((candidate) => candidate.item_id === item && candidate.retracted === null)
        .at(-1)
      if (undo || !file) {
        toast.show({ message: undo ? 'Отменено' : `${item} привязан к заказу` })
        return
      }
      toast.show({
        message: `${item} привязан к заказу`,
        action: {
          label: 'Отменить',
          onSelect: () => unlink.start({ order: next, file, reason: 'отменено сразу', undo: true }),
        },
        undoable: true,
      })
    },
  })

  const unlink = useIntentMutation<UnlinkIntent, HubOrder>({
    failed: 'Файл не отвязался',
    run: ({ order, file, reason }, key) =>
      api.hubOrders.retractDelivery({
        params: { model, code: order.code, delivery: file.id },
        body: { reason },
        idempotencyKey: key,
      }),
    onSuccess: (next, { file, undo }) => {
      saved(next)
      toast.show(
        undo
          ? { message: 'Отменено' }
          : {
              message: `${file.item_id} отвязан от заказа`,
              action: {
                label: 'Вернуть',
                onSelect: () => link.start({ order: next, item: file.item_id, undo: true }),
              },
              undoable: true,
            },
      )
    },
  })

  // «Съёмка» (пакет C3): шаг пишется в Hub сразу, от имени человека; Hub отказывает, если шаг не его.
  const step = useIntentMutation<{ order: HubOrder; body: HubOrderStepCommand }, HubOrder>({
    failed: 'Шаг не записан',
    run: ({ order, body }, key) =>
      api.hubOrders.step({ params: { model, code: order.code }, body, idempotencyKey: key }),
    onSuccess: (next) => {
      saved(next)
      toast.show({ message: `${next.code}: ${next.status.word}, записано` })
    },
  })

  const refresh = useIntentMutation<undefined, HubOrderList>({
    failed: 'Не обновилось',
    run: (_, key) => api.hubOrders.refresh({ params: { model }, idempotencyKey: key }),
    onSuccess: (list) => {
      queryClient.setQueryData(queryKeys.hubOrders(model), list)
    },
  })

  return {
    link: (order: HubOrder, item: ItemId) => link.start({ order, item }),
    linking: link.isPending,
    unlink: (order: HubOrder, file: HubOrderFile, reason: string) =>
      unlink.start({ order, file, reason }),
    unlinking: unlink.isPending,
    step: (order: HubOrder, body: HubOrderStepCommand) => step.start({ order, body }),
    stepping: step.isPending,
    refresh: () => refresh.start(undefined),
    refreshing: refresh.isPending,
  }
}

export type HubOrderActions = ReturnType<typeof useHubOrderActions>
