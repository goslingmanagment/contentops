import type { ItemLifecycle } from '../domain/item'
import type { ItemId } from '../domain/item-type'
import { itemTypeOf } from '../domain/item-type'
import type { ItemRecord, ModelWorld } from './world-types'

/**
 * «Удалённые объекты · 3» (DESIGN §4.1, §3.10): удалённый фуп и две слитые съёмки. Номера
 * взяты из пропусков каталога, поэтому счётчики номеров и числа разделов не меняются.
 */
interface DeletedSpec {
  id: ItemId
  title: string
  lifecycle: Exclude<ItemLifecycle, { state: 'active' }>
}

const LORA_DELETED: readonly DeletedSpec[] = [
  {
    id: 'FYP-0650',
    title: 'Каблуки у окна',
    lifecycle: { state: 'deleted', at: '2026-09-12T15:40:00Z', by: 'Диана' },
  },
  {
    id: 'RAW-0211',
    title: 'Съёмка 7 сентября',
    lifecycle: { state: 'merged', into: 'RAW-0210', at: '2026-09-16T09:05:00Z' },
  },
  {
    id: 'LIFE-189',
    title: 'Цветы, второй день',
    lifecycle: { state: 'merged', into: 'LIFE-188', at: '2026-09-20T12:30:00Z' },
  },
]

/** Удалённый объект сохраняет запись с прежним ID; в индекс и списки он не попадает. */
export function addLoraDeleted(model: ModelWorld): void {
  for (const spec of LORA_DELETED) {
    const template = [...model.items.values()].find(
      (record) => record.entry.type === itemTypeOf(spec.id),
    )
    if (!template || model.items.has(spec.id)) continue
    const record: ItemRecord = {
      ...template,
      entry: {
        ...template.entry,
        id: spec.id,
        title: spec.title,
        cover: { ...template.entry.cover, key: spec.id },
      },
      lifecycle: spec.lifecycle,
      files: null,
      frames: null,
      markup: null,
      fyp_versions: [],
      provenance: [],
      old_names: [],
      receipts: [],
    }
    model.items.set(spec.id, record)
  }
}
