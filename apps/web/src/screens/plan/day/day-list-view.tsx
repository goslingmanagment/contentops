import type { Account, AccountCode, PlanRow, SlotGap } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { type CSSProperties, useCallback } from 'react'
import { DAY_ITEM_HEIGHT, type DayListItem, isRowItem } from './day-list'
import { CancelledHead, GapRow, GroupHead, UnplannedLine } from './day-list-items'
import { DayRow } from './day-row'
import { MergedRow } from './merged-row'
import { rowActionsWidth } from './row-actions-width'

export interface DayListHandlers {
  menuFor: (row: PlanRow) => ItemMenuModel
  /** Клик по заголовку группы выделяет все её строки (§3.3). */
  selectRows: (rowIds: readonly string[]) => void
  /** ◆ «Сверить»: строка выделяется, пара открывается в панели. */
  checkRow: (row: PlanRow) => void
  uploadMontage: (row: PlanRow) => void
  setFilesOver: (row: PlanRow, over: boolean) => void
  downloadRow: (row: PlanRow) => void
  pickGap: (gap: SlotGap) => void
  /** «Hub видел 1 пост без плана · Сверить»: сразу к этому посту в «Сверить». */
  openCheck: (account: AccountCode) => void
  /** «⋯ → Отметить выложенное вне плана…» в заголовке группы; нет у «только чтение». */
  outsidePlan: ((account?: AccountCode) => void) | null
  openRow: (rows: readonly PlanRow[]) => void
  previewRow: (rows: readonly PlanRow[]) => void
}

interface DayListViewProps {
  items: readonly DayListItem[]
  accounts: readonly Account[]
  canAct: boolean
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  /** Меню «Отметить ▾» открыто у строки: клавиша `2`. */
  markMenuRow: string | null
  onMarkMenuRowChange: (rowId: string | null) => void
  handlers: DayListHandlers
  initialScrollOffset: number | undefined
  onScrollOffsetChange: (offset: number) => void
  /** Строка, к которой экран прокручивает сам: первая отменённая после «⋯ → Отменённые». */
  focusKey?: string | null
}

const itemKey = (item: DayListItem) => item.key
const itemHeight = (item: DayListItem) => DAY_ITEM_HEIGHT[item.kind]

function rowsOf(item: DayListItem): PlanRow[] {
  if (item.kind === 'row') {
    return [item.row]
  }
  return item.kind === 'merged' ? item.rows : []
}

/**
 * Список дня (DESIGN §4.11): группы страниц со строками 54 и местами нормы, виртуальный,
 * с той же клавиатурой и выделением, что у сетки Библиотеки (§3.3, §3.13).
 */
export function DayListView({
  items,
  accounts,
  canAct,
  selectedKeys,
  onSelectedKeysChange,
  markMenuRow,
  onMarkMenuRowChange,
  handlers,
  initialScrollOffset,
  onScrollOffsetChange,
  focusKey = null,
}: DayListViewProps) {
  const { openRow, previewRow } = handlers
  const onOpen = useCallback((item: DayListItem) => openRow(rowsOf(item)), [openRow])
  const onPreview = useCallback((item: DayListItem) => previewRow(rowsOf(item)), [previewRow])
  const renderItem = (item: DayListItem, state: { selected: boolean }) => (
    <DayItem
      item={item}
      selected={state.selected}
      accounts={accounts}
      canAct={canAct}
      markMenuRow={markMenuRow}
      onMarkMenuRowChange={onMarkMenuRowChange}
      handlers={handlers}
    />
  )
  const actions = { '--row-actions': `${rowActionsWidth(items, canAct)}px` } as CSSProperties
  return (
    <div className="contents" style={actions}>
      <VirtualList
        items={items}
        getKey={itemKey}
        getItemHeight={itemHeight}
        isSelectable={isRowItem}
        renderItem={renderItem}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={onSelectedKeysChange}
        onOpen={onOpen}
        onPreview={onPreview}
        label="Строки дня"
        initialScrollOffset={initialScrollOffset}
        onScrollOffsetChange={onScrollOffsetChange}
        focusKey={focusKey}
        className="-mx-2 px-2 pb-8"
      />
    </div>
  )
}

interface DayItemProps {
  item: DayListItem
  selected: boolean
  accounts: readonly Account[]
  canAct: boolean
  markMenuRow: string | null
  onMarkMenuRowChange: (rowId: string | null) => void
  handlers: DayListHandlers
}

function DayItem({
  item,
  selected,
  accounts,
  canAct,
  markMenuRow,
  onMarkMenuRowChange,
  handlers,
}: DayItemProps) {
  switch (item.kind) {
    case 'group':
      return (
        <GroupHead
          account={item.account}
          group={item.group}
          rowCount={item.rowIds.length}
          onSelectAll={() => handlers.selectRows(item.rowIds)}
          onOutsidePlan={
            handlers.outsidePlan ? () => handlers.outsidePlan?.(item.account.code) : undefined
          }
        />
      )
    case 'row': {
      const { row } = item
      return (
        <DayRow
          row={row}
          accountLabel={item.accountLabel}
          selected={selected}
          canAct={canAct}
          menu={handlers.menuFor(row)}
          onCheck={() => handlers.checkRow(row)}
          onUploadMontage={() => handlers.uploadMontage(row)}
          onDownload={() => handlers.downloadRow(row)}
          onFilesOver={
            row.awaiting_montage ? (over) => handlers.setFilesOver(row, over) : undefined
          }
          markMenuOpen={markMenuRow === row.id}
          onMarkMenuOpenChange={(open) => onMarkMenuRowChange(open ? row.id : null)}
        />
      )
    }
    case 'merged':
      return <MergedRow rows={item.rows} accounts={accounts} selected={selected} canAct={canAct} />
    case 'gap':
      return (
        <GapRow
          gap={item.gap}
          accountLabel={item.accountLabel}
          canAct={canAct}
          onPick={() => handlers.pickGap(item.gap)}
        />
      )
    case 'unplanned':
      return <UnplannedLine count={item.count} onCheck={() => handlers.openCheck(item.account)} />
    case 'cancelled':
      return <CancelledHead count={item.count} />
  }
}
