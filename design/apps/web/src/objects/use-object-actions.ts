import {
  type CatalogEntry,
  type DownloadAnswer,
  DownloadKindSchema,
  formatNumber,
  type ItemId,
} from '@contentops/contracts'
import { useCallback } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useDeliverDownload } from '@/actions/use-deliver-download'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { useCurrentModel } from '@/shell/model/model-context'

interface DownloadRequest {
  kind: string
  stripMetadata: boolean
}

interface PromoRequest {
  channel: string
  collection: ItemId | 'new'
}

/**
 * Действия над выбранными объектами Библиотеки (DESIGN §3.3): «В план», «Скачать ▾»,
 * «В промо ▾», «Скопировать ID». Каждое нажатие — своё намерение со своим ключом повтора;
 * у объектов пакета ключ производный, поэтому «Повторить» не скачает дважды.
 */
export function useObjectActions(entries: readonly CatalogEntry[]) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const deliver = useDeliverDownload()
  const { openPlanDialog } = usePlanDialog()
  const ids = entries.map((entry) => entry.id)

  const download = useIntentMutation<DownloadRequest, DownloadAnswer[]>({
    failed: 'Не скачалось',
    run: ({ kind, stripMetadata }, key) =>
      Promise.all(
        ids.map((id) =>
          api.objects.download({
            params: { model, id },
            body: {
              kind: DownloadKindSchema.parse(kind),
              strip_metadata: stripMetadata,
              account: null,
            },
            idempotencyKey: `${key}:${id}`,
          }),
        ),
      ),
    onSuccess: (answers) => deliver(model, answers, { building: 'Копия собирается' }),
  })

  const addToPromo = useIntentMutation<PromoRequest, { id: ItemId }>({
    failed: 'Не добавилось в промо',
    run: async ({ channel, collection }, key) =>
      api.promo.add({
        params: { model },
        body: {
          channel,
          collection,
          title: null,
          members: ids.map((id) => ({ item_id: id, file_key: 'master' })),
        },
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.promoChannels(model), queryKeys.catalogIndex(model)],
    onSuccess: (collection) => toast.show({ message: `Добавлено в ${collection.id}` }),
  })

  const copyIds = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ids.join(' '))
      toast.show({
        message: `Скопировано · ${ids.length === 1 ? ids[0] : `${formatNumber(ids.length)} ID`}`,
      })
    } catch (error) {
      toast.showFailure(error, { failed: 'Не скопировалось' })
    }
  }, [ids, toast])

  return {
    planIds: () => openPlanDialog(ids),
    download: (kind: string, stripMetadata: boolean) => download.start({ kind, stripMetadata }),
    downloading: download.isPending,
    addToPromo: (channel: string, collection: ItemId | 'new') =>
      addToPromo.start({ channel, collection }),
    copyIds,
  }
}
