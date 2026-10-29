import { type Account, formatNumber } from '@contentops/contracts'
import { ItemContextMenu, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { useCallback, useMemo } from 'react'
import { useHistoryScroll } from '@/lib/use-history-state'
import { OrderRow } from './order-row'
import { type OrderListRow, rowHeight } from './order-rows'

type GroupRow = Extract<OrderListRow, { kind: 'group' }>
type OrderItemRow = Extract<OrderListRow, { kind: 'order' }>

interface OrderListProps {
  rows: readonly OrderListRow[]
  accounts: readonly Account[]
  /** Заголовок группы словами: «Ждём от Лоры». */
  groupLabel: (row: GroupRow) => string
  selectedId: string | null
  onSelect: (id: string) => void
  /** То же меню, что «⋯» в панели заказа, по правому клику на строке (§3.6). */
  menuFor: (row: OrderItemRow) => ItemMenuModel
  /** Место прокрутки живёт в записи истории, у каждой вкладки своё (§3.13). */
  scrollKey: string
  /** Текущее место прокрутки — чтобы унести его на другой адрес вместе с «Назад». */
  onScrolled?: (offset: number) => void
}

const isOrder = (row: OrderListRow) => row.kind === 'order'
const keyOf = (row: OrderListRow) => row.key

/**
 * Список заказов (DESIGN §4.16): группы по состоянию, строки 64. Заказы массово не
 * выделяются (§3.3): выбор одного открывает его панель; стрелки и `Enter` ходят по строкам.
 */
export function OrderList({
  rows,
  accounts,
  groupLabel,
  selectedId,
  onSelect,
  menuFor,
  scrollKey,
  onScrolled,
}: OrderListProps) {
  const scroll = useHistoryScroll(scrollKey)
  const selectedKeys = useMemo(() => new Set(selectedId ? [selectedId] : []), [selectedId])
  const { onScrollOffsetChange } = scroll
  const onScroll = useCallback(
    (offset: number) => {
      onScrollOffsetChange(offset)
      onScrolled?.(offset)
    },
    [onScrollOffsetChange, onScrolled],
  )

  // Из набора выбранных берётся один: новый, если он появился. Пустой набор (`Esc`)
  // панель не закрывает — это делает клавиша экрана.
  const onSelectedKeysChange = useCallback(
    (next: Set<string>) => {
      const added = [...next].find((key) => key !== selectedId)
      if (added) onSelect(added)
    },
    [onSelect, selectedId],
  )

  return (
    <VirtualList
      items={rows}
      getKey={keyOf}
      getItemHeight={rowHeight}
      isSelectable={isOrder}
      selectedKeys={selectedKeys}
      onSelectedKeysChange={onSelectedKeysChange}
      onOpen={(row) => onSelect(row.key)}
      label="Заказы"
      initialScrollOffset={scroll.initialOffset}
      onScrollOffsetChange={onScroll}
      className="@container -mx-2 px-2 pb-8"
      renderItem={(row, state) =>
        row.kind === 'group' ? (
          <div className="flex h-11 items-end px-2 pb-2">
            <h2 className="flex items-baseline gap-2 text-lg">
              {groupLabel(row)}
              <span className="font-normal text-ink-3 text-sm tabular-nums">
                {formatNumber(row.count)}
              </span>
            </h2>
          </div>
        ) : (
          <ItemContextMenu menu={menuFor(row)}>
            <div>
              <OrderRow
                order={row.order}
                accounts={accounts}
                selected={state.selected}
                onOpen={() => onSelect(row.key)}
              />
            </div>
          </ItemContextMenu>
        )
      }
    />
  )
}
