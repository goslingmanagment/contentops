import type {
  Account,
  AccountCode,
  CatalogEntry,
  ItemId,
  PageSummaryEntry,
} from '@contentops/contracts'
import { ObjectTile, type ObjectTileView } from '@contentops/ui/components/object-tile'
import { memo } from 'react'
import { useToday } from '@/data/api-session'
import { usePrefetchItem } from '@/data/object'
import { itemCover } from '@/lib/item-cover'
import { tileSignOf } from '@/objects/placement-text'
import { useCurrentModel } from '@/shell/model/model-context'
import { entryColumns } from './entry-columns'
import { type TileHint, tileHintText, tileHintTitle } from './tile-hint'

interface EntryTileProps {
  entry: CatalogEntry
  view: ObjectTileView
  accounts: readonly Account[]
  summaries: readonly PageSummaryEntry[] | undefined
  hint: TileHint | null
  /** Экран одной страницы: знак на плитке — только о ней (DESIGN §4.3). */
  page?: AccountCode
  selected: boolean
  onToggle: (id: ItemId, selected: boolean) => void
}

/**
 * Объект каталога плиткой или строкой (DESIGN §4.2): обложка по семейству типа, знак
 * только при ◆ или ▲, под названием ID и ответ по выбранной странице.
 */
export const EntryTile = memo(function EntryTile({
  entry,
  view,
  accounts,
  summaries,
  hint,
  page,
  selected,
  onToggle,
}: EntryTileProps) {
  const cover = itemCover(entry)
  const today = useToday()
  // Карточка объекта начинает читаться до открытия: наведение, фокус, первый щелчок (§3.13).
  const prefetch = usePrefetchItem(useCurrentModel().code)
  const warm = () => prefetch(entry.id)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: обработчики только прогревают кэш карточки, своего действия у обёртки нет
    <div
      data-entry-id={entry.id}
      className="h-full"
      onPointerEnter={warm}
      onFocus={warm}
      onClickCapture={warm}
    >
      <ObjectTile
        view={view}
        id={entry.id}
        title={entry.title}
        kind={cover.kind}
        coverFamily={cover.family}
        durationSeconds={cover.durationSeconds}
        countLabel={cover.countLabel}
        versionCount={cover.versionCount}
        sign={tileSignOf(summaries, accounts, page)}
        placementHint={hint ? tileHintText(hint, summaries, view === 'tile') : undefined}
        placementTitle={hint ? tileHintTitle(hint, summaries) : undefined}
        columns={view === 'row' ? entryColumns(entry, accounts, summaries, today) : undefined}
        selected={selected}
        onSelectedChange={(checked) => onToggle(entry.id, checked)}
      />
    </div>
  )
})
