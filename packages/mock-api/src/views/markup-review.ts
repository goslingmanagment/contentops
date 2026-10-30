import type { MarkupReviewItem } from '@contentops/contracts/domain/markup-review'
import { synthesizeMarkup } from '../fixtures/item-files'
import type { ModelWorld } from '../fixtures/world-types'

/** Объекты, где есть поле с черновиком (ИИ, импорт или имя), новые первыми. */
export function markupReview(model: ModelWorld): MarkupReviewItem[] {
  return [...model.items.values()]
    .filter((record) => record.lifecycle.state === 'active' && record.entry.markup !== 'confirmed')
    .sort((left, right) => right.entry.arrived_on.localeCompare(left.entry.arrived_on))
    .map((record) => ({
      item_id: record.entry.id,
      fields: record.markup ?? synthesizeMarkup(record.entry),
    }))
}
