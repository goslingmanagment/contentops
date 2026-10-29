import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from 'cn'
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef } from 'react'
import { callWithItem } from '../lib/call-with-item'
import { buildGroupedRows, groupSpans, rowOfIndex, verticalNeighbour } from '../lib/grouped-rows'
import { useCollectionNavigation } from '../lib/use-collection-navigation'
import { useElementWidth } from '../lib/use-element-width'
import { CollectionOption } from './collection-option'
import type { CollectionItemState } from './virtual-grid'

export interface ItemGroup<Item> {
  key: string
  /** Элементы группы; у свёрнутой группы — пусто, заголовок остаётся. */
  items: readonly Item[]
}

export interface GroupHeaderState {
  /** Выделить всё в группе: клик по заголовку группы (DESIGN §3.3). */
  selectAll: () => void
}

interface GroupedVirtualGridProps<Item, Group extends ItemGroup<Item>> {
  groups: readonly Group[]
  getKey: (item: Item) => string
  renderItem: (item: Item, state: CollectionItemState) => ReactNode
  renderHeader: (group: Group, state: GroupHeaderState) => ReactNode
  /** Высота строки заголовка группы. */
  headerHeight: number
  /** Строка после всех групп: «ещё 12 уже в плане». */
  footer?: ReactNode
  footerHeight?: number
  /** Наименьшая ширина ячейки; у списка — бесконечность, одна колонка. */
  minColumnWidth: number
  getRowHeight: (columnWidth: number) => number
  gap?: number
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  onOpen?: (item: Item, index: number) => void
  onPreview?: (item: Item, index: number) => void
  label: string
  initialScrollOffset?: number
  onScrollOffsetChange?: (offset: number) => void
  className?: string
}

/**
 * Виртуальная сетка с группами (DESIGN §3.13, §4.3): заголовок группы и ряды плиток
 * фиксированной высоты, сотни фупов листаются без подгрузок. Стрелки ходят по рядам и
 * переходят из группы в группу, `Ctrl A` выделяет всё, клик по заголовку — всю группу.
 */
export function GroupedVirtualGrid<Item, Group extends ItemGroup<Item>>({
  groups,
  getKey,
  renderItem,
  renderHeader,
  headerHeight,
  footer,
  footerHeight = 0,
  minColumnWidth,
  getRowHeight,
  gap = 16,
  selectedKeys,
  onSelectedKeysChange,
  onOpen,
  onPreview,
  label,
  initialScrollOffset,
  onScrollOffsetChange,
  className,
}: GroupedVirtualGridProps<Item, Group>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const width = useElementWidth(scrollRef)
  const columns = Number.isFinite(minColumnWidth)
    ? Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
    : 1
  const columnWidth = width > 0 ? (width - gap * (columns - 1)) / columns : minColumnWidth
  const rowHeight = getRowHeight(columnWidth)

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const keys = useMemo(() => items.map(getKey), [items, getKey])
  const spans = useMemo(() => groupSpans(groups.map((group) => group.items.length)), [groups])
  const rows = useMemo(
    () => buildGroupedRows(spans, columns, footer !== undefined),
    [spans, columns, footer],
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (row?.kind === 'header') {
        return headerHeight
      }
      return row?.kind === 'footer' ? footerHeight : rowHeight + gap
    },
    overscan: 3,
    initialOffset: initialScrollOffset,
    onChange: (instance) => onScrollOffsetChange?.(instance.scrollOffset ?? 0),
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rows, rowHeight])

  const scrollToIndex = useCallback(
    (index: number) => {
      const row = rowOfIndex(rows, index)
      if (row >= 0) {
        virtualizer.scrollToIndex(row, { align: 'auto' })
      }
    },
    [rows, virtualizer],
  )
  const verticalTarget = useCallback(
    (index: number, direction: 1 | -1) => verticalNeighbour(spans, columns, index, direction),
    [spans, columns],
  )
  const navigation = useCollectionNavigation({
    keys,
    columns,
    selectedKeys,
    onSelectedKeysChange,
    scrollToIndex,
    verticalTarget,
    onOpen: onOpen ? (index) => callWithItem(items, index, onOpen) : undefined,
    onPreview: onPreview ? (index) => callWithItem(items, index, onPreview) : undefined,
  })

  const renderRow = (rowIndex: number) => {
    const row = rows[rowIndex]
    if (!row) {
      return null
    }
    if (row.kind === 'footer') {
      return footer
    }
    const group = groups[row.group]
    const span = spans[row.group]
    if (!group || !span) {
      return null
    }
    if (row.kind === 'header') {
      return renderHeader(group, {
        selectAll: () =>
          onSelectedKeysChange(new Set(keys.slice(span.start, span.start + span.count))),
      })
    }
    return (
      <div
        className="grid h-full"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap }}
      >
        {items.slice(row.start, row.end).map((item, offset) => {
          const index = row.start + offset
          const key = keys[index] ?? String(index)
          const selected = selectedKeys.has(key)
          const focused = index === navigation.focusIndex
          return (
            <CollectionOption
              key={key}
              id={`${listId}-${index}`}
              index={index}
              selected={selected}
              focused={focused}
              onItemClick={navigation.handleItemClick}
              onItemDoubleClick={navigation.handleItemDoubleClick}
            >
              {renderItem(item, { index, selected, focused })}
            </CollectionOption>
          )
        })}
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label={label}
      aria-multiselectable
      aria-activedescendant={items.length > 0 ? `${listId}-${navigation.focusIndex}` : undefined}
      tabIndex={0}
      onKeyDown={navigation.handleKeyDown}
      className={cn('group/collection relative h-full overflow-y-auto outline-none', className)}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]
          const height = row?.kind === 'tiles' ? rowHeight : virtualRow.size
          return (
            <div
              key={virtualRow.key}
              role={row?.kind === 'tiles' ? undefined : 'presentation'}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)`, height }}
            >
              {renderRow(virtualRow.index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
