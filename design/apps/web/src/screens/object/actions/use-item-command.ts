import type { ItemDetail } from '@contentops/contracts'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useItemWriter } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'

interface ItemCommandOptions<Variables> {
  /** Что не вышло, для полоски ошибки: «Не сохранилось». */
  failed: string
  run: (variables: Variables, idempotencyKey: string) => Promise<ItemDetail>
  /** После ответа сервера: полоска «Сохранено · Отменить», следующий шаг. */
  onSaved?: (detail: ItemDetail, variables: Variables) => void
  /** Отказ, который часть страницы показывает сама (конфликт версии на месте поля). */
  handleFailure?: (error: unknown, variables: Variables) => boolean
}

/**
 * Правка объекта, на которую сервер отвечает новой карточкой: она сразу встаёт на экран,
 * а «сохранено» говорится только после ответа (DESIGN §3.13, п. 6).
 */
export function useItemCommand<Variables>({
  failed,
  run,
  onSaved,
  handleFailure,
}: ItemCommandOptions<Variables>) {
  const write = useItemWriter(useCurrentModel().code)
  return useIntentMutation<Variables, ItemDetail>({
    failed,
    run,
    handleFailure,
    onSuccess: (detail, variables) => {
      write(detail)
      onSaved?.(detail, variables)
    },
  })
}
