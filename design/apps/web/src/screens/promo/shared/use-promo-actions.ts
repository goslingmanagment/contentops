import {
  formatBytes,
  type Handoff,
  type HandoffStarted,
  type ItemId,
  type MemberRef,
  type PromoCollection,
} from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { usePromoChanged } from '@/data/promo'
import { filesWord } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { useUploads } from '@/shell/upload/upload-context'

interface PrepareIntent {
  channel: string
  collection: ItemId
  contractor: string
  stripMetadata: boolean
  excludeAlreadyHanded: boolean
  /** `null` — вся подборка; иначе только выбранные в ней материалы. */
  members: readonly MemberRef[] | null
  /** Размер для строки лотка: «Передача PRM-015 готовится · 2,6 ГБ». */
  sizeBytes: number
  onStarted: (handoffId: string) => void
}

interface SentIntent {
  channel: string
  handoff: Handoff
}

interface AddIntent {
  channel: string
  collection: ItemId | 'new'
  /** Название новой подборки: «Гиф-сайты, 23 сентября». */
  title?: string
  members: readonly MemberRef[]
  onAdded?: (collection: PromoCollection) => void
  /** Возврат убранного из полоски: своя полоска без «Вернуть». */
  undo?: boolean
}

interface RemoveIntent {
  channel: string
  collection: ItemId
  members: readonly MemberRef[]
  onRemoved?: () => void
}

/**
 * Команды Промо (DESIGN §4.17, §3.8): подготовить передачу (202, ход — в лотке),
 * отметить «Передано», добавить в подборку и убрать из неё. Каждое нажатие — своё
 * намерение со своим ключом повтора; полоска — только после ответа.
 */
export function usePromoActions() {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const changed = usePromoChanged(model)
  const { trackOperation } = useUploads()

  const prepare = useIntentMutation<PrepareIntent, HandoffStarted>({
    failed: 'Передача не началась',
    run: (intent, key) =>
      api.promo.prepareHandoff({
        params: { model, collection: intent.collection },
        body: {
          contractor_id: intent.contractor,
          strip_metadata: intent.stripMetadata,
          exclude_already_handed: intent.excludeAlreadyHanded,
          members: intent.members ? [...intent.members] : null,
        },
        idempotencyKey: key,
      }),
    onSuccess: (started, intent) => {
      trackOperation(
        model,
        started.operation_id,
        `Передача ${intent.collection} готовится · ${formatBytes(intent.sizeBytes)}`,
      )
      void changed(intent.channel, intent.collection).then(() =>
        intent.onStarted(started.handoff_id),
      )
    },
  })

  const markSent = useIntentMutation<SentIntent, Handoff>({
    failed: 'Не отметилось',
    run: ({ handoff }, key) =>
      api.promo.markSent({
        params: { model, collection: handoff.collection_id, handoff: handoff.id },
        idempotencyKey: key,
      }),
    onSuccess: (handoff, { channel }) => {
      void changed(channel, handoff.collection_id)
      toast.show({ message: `Передано · ${handoff.contractor_name}` })
    },
  })

  const add = useIntentMutation<AddIntent, PromoCollection>({
    failed: 'Не добавилось',
    run: ({ channel, collection, title, members }, key) =>
      api.promo.add({
        params: { model },
        body: { channel, collection, title: title ?? null, members: [...members] },
        idempotencyKey: key,
      }),
    onSuccess: (collection, { channel, members, onAdded, undo }) => {
      void changed(channel, collection.id)
      onAdded?.(collection)
      toast.show({
        message: undo
          ? 'Возвращено'
          : `Добавлено в ${collection.id} · ${filesWord(members.length)}`,
      })
    },
  })

  const remove = useIntentMutation<RemoveIntent, PromoCollection>({
    failed: 'Не убралось',
    run: ({ collection, members }, key) =>
      api.promo.remove({
        params: { model, collection },
        body: { members: [...members] },
        idempotencyKey: key,
      }),
    onSuccess: (collection, { channel, members, onRemoved }) => {
      void changed(channel, collection.id)
      onRemoved?.()
      toast.show({
        message: `Убрано из ${collection.id} · ${filesWord(members.length)}`,
        undoable: true,
        action: {
          label: 'Вернуть',
          onSelect: () => add.start({ channel, collection: collection.id, members, undo: true }),
        },
      })
    },
  })

  return {
    prepare: prepare.start,
    preparing: prepare.isPending,
    markSent: markSent.start,
    marking: markSent.isPending,
    add: add.start,
    adding: add.isPending,
    remove: remove.start,
  }
}
