import type { ItemId } from '@contentops/contracts'
import { useParams } from '@tanstack/react-router'
import { useCatalogIndex } from '@/data/catalog'
import { type ItemCover, itemCover, itemCoverById } from '@/lib/item-cover'
import { useOptionalModel } from '@/shell/model/model-context'

/**
 * Обложка объекта по одному ID (журнал, заказы, сверка, цель загрузки): из индекса каталога —
 * с настоящей миниатюрой. Объекта в индексе нет (удалён, индекс ещё грузится) — без картинки,
 * место серое (DESIGN §3.10). Подписей нет: длительность и состав говорит строка рядом.
 */
export function useItemCover(id: ItemId): Pick<ItemCover, 'seed' | 'kind' | 'family' | 'src'> {
  // Окно «Загрузить» живёт в оболочке, вне экрана модели: тогда модель — из адреса.
  const scoped = useOptionalModel()?.code
  const fromAddress = useParams({ strict: false }).model
  const model = scoped ?? fromAddress
  const entry = useCatalogIndex(model ?? '', model !== undefined).data?.byId.get(id)
  if (!entry) {
    return itemCoverById(id)
  }
  const { seed, kind, family, src } = itemCover(entry)
  return { seed, kind, family, src }
}
