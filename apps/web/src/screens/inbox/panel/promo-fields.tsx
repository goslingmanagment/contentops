import type { InboxGroup } from '@contentops/contracts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { useId } from 'react'
import { useCatalogIndex } from '@/data/catalog'
import { usePromoChannels } from '@/data/promo'
import { useCurrentModel } from '@/shell/model/model-context'
import { FieldRow } from './field-row'
import type { DraftSave } from './use-draft-save'

const NEW_COLLECTION = 'new'

/**
 * Промо-материал, снятый для канала (DESIGN §2.5): «Канал ▾» подставлен из пути
 * `9. SMM/Instagram/…`, «Подборка: новая / PRM-015 ▾» — подборки этого канала.
 */
export function PromoFields({ group, saver }: { group: InboxGroup; saver: DraftSave }) {
  const model = useCurrentModel().code
  const channels = usePromoChannels(model).data ?? []
  const index = useCatalogIndex(model).data
  const channelId = useId()
  const collectionId = useId()
  const channel = group.fields.channel
  const collections = (index?.items ?? []).filter(
    (entry) => entry.type === 'promo' && entry.channel === channel,
  )
  return (
    <>
      <FieldRow label="Канал" htmlFor={channelId} source={`из пути ${group.source_path}`}>
        <Select
          value={channel ?? undefined}
          onValueChange={(value) => void saver.save({ channel: value, collection: NEW_COLLECTION })}
        >
          <SelectTrigger id={channelId} className="w-full">
            <SelectValue placeholder="Выберите канал" />
          </SelectTrigger>
          <SelectContent>
            {channels.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Подборка" htmlFor={collectionId}>
        <Select
          value={group.fields.collection ?? NEW_COLLECTION}
          onValueChange={(value) => void saver.save({ collection: value })}
          disabled={!channel}
        >
          <SelectTrigger id={collectionId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_COLLECTION}>новая</SelectItem>
            {collections.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.id} · {entry.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
    </>
  )
}
