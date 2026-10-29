import type { ItemId, PromoCollection } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { itemQueryKeys } from '@/data/object'
import { queryKeys } from '@/data/query-keys'
import { useObjectPage } from '../object-context'
import { useFileSelection } from './file-selection'

/** «В промо ▾» у выбранных файлов объекта: ссылками на эти файлы, без копий (§2.5). */
export function useAddFilesToPromo() {
  const { detail, model } = useObjectPage()
  const api = useApi()
  const toast = useActionToast()
  const selection = useFileSelection()
  const { start } = useIntentMutation<
    { channel: string; collection: ItemId | 'new'; keys: string[] },
    PromoCollection
  >({
    failed: 'Не добавилось в промо',
    run: ({ channel, collection, keys }, idempotencyKey) =>
      api.promo.add({
        params: { model: model.code },
        body: {
          channel,
          collection,
          title: null,
          members: keys.map((key) => ({ item_id: detail.entry.id, file_key: key })),
        },
        idempotencyKey,
      }),
    invalidates: () => [queryKeys.promoChannels(model.code), queryKeys.catalogIndex(model.code)],
    onSuccess: (collection) => {
      selection.clear()
      toast.show({ message: `Добавлено в ${collection.id}` })
    },
  })
  return (channel: string, collection: ItemId | 'new') =>
    start({ channel, collection, keys: [...selection.keys] })
}

/** «Убрать из подборки» у материалов промо-подборки (DESIGN §3.3). */
export function useRemoveFromCollection() {
  const { detail, model } = useObjectPage()
  const api = useApi()
  const toast = useActionToast()
  const selection = useFileSelection()
  const { start } = useIntentMutation<string[], PromoCollection>({
    failed: 'Не убралось из подборки',
    run: (keys, idempotencyKey) =>
      api.promo.remove({
        params: { model: model.code, collection: detail.entry.id },
        body: {
          members: detail.files
            .filter((file) => keys.includes(file.key) && file.source)
            .flatMap((file) => (file.source ? [file.source] : [])),
        },
        idempotencyKey,
      }),
    invalidates: () => itemQueryKeys(model.code, detail.entry.id),
    onSuccess: (_collection, keys) => {
      selection.clear()
      toast.show({ message: `Убрано из подборки · ${keys.length}` })
    },
  })
  return start
}
