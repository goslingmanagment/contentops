import { type Account, type CatalogEntry, formatNumber, type ItemId } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { useCurrentModel } from '@/shell/model/model-context'

interface AlreadyUploadedCallbacks {
  /** Отметка прошла: выделение снимается, отмеченное уходит из списка. */
  onMarked: () => void
  /** «Показать» в полоске итога выделяет непрошедшие. */
  onShowFailed: (ids: ItemId[]) => void
}

/**
 * «Уже залито» (DESIGN §4.3): КМ проверила vault руками — у выбранных появляется отметка
 * на странице вкладки, как у строки «выложено вне плана». Пакет «по каждой записи»:
 * итог одной полоской, «Показать» выделяет непрошедшие (§3.3).
 */
export function useAlreadyUploaded(
  account: Account,
  { onMarked, onShowFailed }: AlreadyUploadedCallbacks,
) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const mark = useIntentMutation({
    failed: 'Не отметилось',
    run: (entries: readonly CatalogEntry[], key) =>
      api.objects.alreadyUploaded({
        params: { model },
        body: { account: account.code, items: entries.map((entry) => entry.id) },
        idempotencyKey: key,
      }),
    invalidates: () => [
      queryKeys.pageSummaries(model),
      queryKeys.notUploaded(model, account.code),
      queryKeys.counters(),
    ],
    onSuccess: ({ results }) => {
      const failed = results.flatMap((result) => (result.ok ? [] : [result.id]))
      const done = results.length - failed.length
      onMarked()
      if (failed.length === 0) {
        toast.show({ message: `Отмечено залитым на ${account.label} · ${formatNumber(done)}` })
        return
      }
      toast.show({
        message: `Отмечено ${formatNumber(done)} из ${formatNumber(results.length)} · ${formatNumber(failed.length)} уже изменили`,
        action: { label: 'Показать', onSelect: () => onShowFailed(failed) },
      })
    },
  })
  return { markUploaded: mark.start, marking: mark.isPending }
}
