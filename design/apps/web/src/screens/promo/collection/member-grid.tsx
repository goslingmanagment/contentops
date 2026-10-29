import type { CollectionMember } from '@contentops/contracts'
import { VirtualGrid } from '@contentops/ui/components/virtual-grid'
import { toggleKey } from '@contentops/ui/lib/selection'
import { useToday } from '@/data/api-session'
import { useHistoryScroll } from '@/lib/use-history-state'
import { MEMBER_GRID, type MemberCell, MemberTile, memberTileHeight } from '../shared/member-tile'
import { type HandedScope, handedText, memberKey } from '../shared/promo-text'

interface MemberGridProps {
  collectionId: string
  members: readonly CollectionMember[]
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  /** `Enter` и двойное нажатие — исходный объект материала. */
  onOpen: (member: CollectionMember) => void
  /** Галочки выбора; у «Только чтение» их нет. */
  selectable: boolean
  /** Подборка и её подрядчик: их собственные передачи на плитках не повторяются. */
  handedScope: HandedScope
}

/**
 * Сетка файлов подборки (DESIGN §4.17): стандартные плитки 3:4 (§7.6), сотни материалов
 * листаются без подгрузок (§3.13); выделение — щелчок, `Shift`, `Ctrl`.
 */
export function MemberGrid({
  collectionId,
  members,
  selectedKeys,
  onSelectedKeysChange,
  onOpen,
  selectable,
  handedScope,
}: MemberGridProps) {
  const today = useToday()
  const scroll = useHistoryScroll(`promo:collection:${collectionId}:scroll`)
  // Подборка YouTube — горизонтальные кадры: ячейки 16:9, без полос вписывания.
  const cell: MemberCell = members[0]?.thumb.ratio === '16:9' ? '16:9' : '3:4'

  return (
    <VirtualGrid
      items={members}
      getKey={memberKey}
      minColumnWidth={MEMBER_GRID[cell].minColumnWidth}
      getRowHeight={(width) => memberTileHeight(width, cell)}
      gap={MEMBER_GRID[cell].gap}
      selectedKeys={selectedKeys}
      onSelectedKeysChange={onSelectedKeysChange}
      onOpen={onOpen}
      label="Материалы подборки"
      initialScrollOffset={scroll.initialOffset}
      onScrollOffsetChange={scroll.onScrollOffsetChange}
      className="-mx-2 px-2 pb-8"
      renderItem={(member, state) => (
        <MemberTile
          member={member}
          selected={state.selected}
          cell={cell}
          handed={handedText(member, handedScope, today)}
          onSelectedChange={
            selectable
              ? () => onSelectedKeysChange(toggleKey(selectedKeys, memberKey(member)))
              : undefined
          }
        />
      )}
    />
  )
}
