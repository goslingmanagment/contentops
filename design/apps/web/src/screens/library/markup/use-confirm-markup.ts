import { formatNumber, type ItemId, isApiError } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { markupReviewKey } from '@/data/catalog'
import { queryKeys } from '@/data/query-keys'
import { useCurrentModel } from '@/shell/model/model-context'
import type { MarkupRowValues } from './markup-values'

function isRecordRefusal(error: unknown): boolean {
  return isApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 429
}

export interface ConfirmTarget {
  id: ItemId
  seen: MarkupRowValues['seen']
}

interface ConfirmCallbacks {
  onConfirmed: () => void
  /** «Показать» в полоске итога выделяет строки, которые уже изменили. */
  onShowFailed: (ids: ItemId[]) => void
}

/**
 * «Подтвердить всю разметку · N» (DESIGN §3.3, §4.20): пакет «по каждой записи». Каждый
 * объект подтверждается ровно теми версиями полей, что были в строке; пришедшее после
 * нажатия остаётся черновиком, а сервер отвечает, что строку уже изменили.
 */
export function useConfirmMarkup({ onConfirmed, onShowFailed }: ConfirmCallbacks) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const confirm = useIntentMutation({
    failed: 'Не подтвердилось',
    run: (targets: readonly ConfirmTarget[], key) =>
      Promise.all(
        targets.map((target) =>
          api.objects
            .confirmMarkup({
              params: { model, id: target.id },
              body: { fields: target.seen },
              idempotencyKey: `${key}:${target.id}`,
            })
            .then(
              () => ({ id: target.id, ok: true }),
              (error: unknown) => {
                // Правило домена или чужая правка — строка «уже изменили»; нет связи и
                // лимит — ошибка всего пакета с «Повторить» тем же ключом.
                if (isRecordRefusal(error)) {
                  return { id: target.id, ok: false }
                }
                throw error
              },
            ),
        ),
      ),
    invalidates: () => [markupReviewKey(model), queryKeys.catalogIndex(model)],
    onSuccess: (results) => {
      const failed = results.flatMap((result) => (result.ok ? [] : [result.id]))
      const done = results.length - failed.length
      onConfirmed()
      toast.show(
        failed.length === 0
          ? { message: `Разметка подтверждена · ${formatNumber(done)}` }
          : {
              message: `Подтверждено ${formatNumber(done)} из ${formatNumber(results.length)} · ${formatNumber(failed.length)} уже изменили`,
              action: { label: 'Показать', onSelect: () => onShowFailed(failed) },
            },
      )
    },
  })
  return { confirm: confirm.start, confirming: confirm.isPending }
}
