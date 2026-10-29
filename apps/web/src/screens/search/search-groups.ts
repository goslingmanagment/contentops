import { type CatalogEntry, ITEM_TYPES, type ItemType } from '@contentops/contracts'
import type { ItemGroup } from '@contentops/ui/components/grouped-virtual-grid'

/**
 * Группы результатов (DESIGN §4.7): сверху «Старый номер PPV-032 был у трёх папок» с его
 * плитками, дальше по типам — по одному ряду из пяти и «ещё 12 →». Выбранный чип «Тип»
 * раскрывает свою группу целиком.
 */
export interface SearchGroup extends ItemGroup<CatalogEntry> {
  kind: ItemType | 'old-number'
  total: number
  /** Сколько не показано в ряду: «ещё 12 →». */
  more: number
}

/** Ряд крупных плиток на корне результата. */
export const GROUP_PREVIEW = 5

interface SearchGroupOptions {
  filter: (entries: readonly CatalogEntry[]) => CatalogEntry[]
  /** Чип «Тип»: только эта группа и целиком. */
  type: ItemType | undefined
  oldNumber: { entries: readonly CatalogEntry[] } | null
}

export function searchGroups(
  found: readonly CatalogEntry[],
  { filter, type, oldNumber }: SearchGroupOptions,
): SearchGroup[] {
  const groups: SearchGroup[] = []
  const shownAbove = new Set<string>()
  const holders = oldNumber && !type ? filter(oldNumber.entries) : []
  if (holders.length > 0) {
    groups.push({ key: 'old-number', kind: 'old-number', items: holders, total: 0, more: 0 })
    for (const entry of holders) {
      shownAbove.add(entry.id)
    }
  }
  const byType = new Map<ItemType, CatalogEntry[]>()
  for (const entry of filter(found)) {
    const list = byType.get(entry.type)
    if (shownAbove.has(entry.id)) {
      continue
    }
    if (list) {
      list.push(entry)
    } else {
      byType.set(entry.type, [entry])
    }
  }
  for (const candidate of ITEM_TYPES) {
    const entries = byType.get(candidate)
    if (!entries || (type && candidate !== type)) {
      continue
    }
    const items = type ? entries : entries.slice(0, GROUP_PREVIEW)
    groups.push({
      key: candidate,
      kind: candidate,
      items,
      total: entries.length,
      more: entries.length - items.length,
    })
  }
  return groups
}
