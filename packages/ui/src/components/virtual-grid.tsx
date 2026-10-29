import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from 'cn'
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef } from 'react'
import { callWithItem } from '../lib/call-with-item'
import { useCollectionNavigation } from '../lib/use-collection-navigation'
import { useElementWidth } from '../lib/use-element-width'
import { CollectionOption } from './collection-option'

export interface CollectionItemState {
  index: number
  selected: boolean
  focused: boolean
}

interface VirtualGridProps<Item> {
  items: readonly Item[]
  getKey: (item: Item) => string
  renderItem: (item: Item, state: CollectionItemState) => ReactNode
  /** Наименьшая ширина ячейки: плитки 160, папки 200, малые плитки 120 (§3.1). */
  minColumnWidth: number
  /** Высота ряда при данной ширине ячейки: у плиток фиксирована, ряды не скачут. */
  getRowHeight: (columnWidth: number) => number
  gap?: number
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  onOpen?: (item: Item, index: number) => void
  onPreview?: (item: Item, index: number) => void
  /** Подпись списка для чтения с экрана: «PPV». */
  label: string
  /** Прокрутка при возврате, из `history.state` (§3.13). */
  initialScrollOffset?: number
  onScrollOffsetChange?: (offset: number) => void
  className?: string
}

/**
 * Виртуальная сетка (DESIGN §3.13): 800 фупов листаются без подгрузок. Колонки считаются
 * из ширины, ячейки фиксированного размера. Фокус — активный элемент списка
 * (`aria-activedescendant`), видимое кольцо только при работе с клавиатуры.
 */
export function VirtualGrid<Item>({
  items,
  getKey,
  renderItem,
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
}: VirtualGridProps<Item>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const width = useElementWidth(scrollRef)
  const columns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
  const columnWidth = width > 0 ? (width - gap * (columns - 1)) / columns : minColumnWidth
  const rowHeight = getRowHeight(columnWidth)
  const rowCount = Math.ceil(items.length / columns)
  const keys = useMemo(() => items.map(getKey), [items, getKey])

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight + gap,
    overscan: 3,
    initialOffset: initialScrollOffset,
    onChange: (instance) => onScrollOffsetChange?.(instance.scrollOffset ?? 0),
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight, columns])

  const scrollToIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(Math.floor(index / columns), { align: 'auto' }),
    [virtualizer, columns],
  )
  const navigation = useCollectionNavigation({
    keys,
    columns,
    selectedKeys,
    onSelectedKeysChange,
    scrollToIndex,
    onOpen: onOpen ? (index) => callWithItem(items, index, onOpen) : undefined,
    onPreview: onPreview ? (index) => callWithItem(items, index, onPreview) : undefined,
  })

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
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="absolute inset-x-0 top-0 grid"
            style={{
              transform: `translateY(${row.start}px)`,
              height: rowHeight,
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              columnGap: gap,
            }}
          >
            {items.slice(row.index * columns, row.index * columns + columns).map((item, column) => {
              const index = row.index * columns + column
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
        ))}
      </div>
    </div>
  )
}
