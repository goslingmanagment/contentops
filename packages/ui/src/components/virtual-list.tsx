import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from 'cn'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
} from 'react'
import { callWithItem } from '../lib/call-with-item'
import { useCollectionNavigation } from '../lib/use-collection-navigation'
import { CollectionOption } from './collection-option'
import type { CollectionItemState } from './virtual-grid'

interface VirtualListProps<Item> {
  items: readonly Item[]
  getKey: (item: Item) => string
  renderItem: (item: Item, state: CollectionItemState) => ReactNode
  /**
   * Высота строки по её виду: строка списка 52, «Приехало» 64, план 54, журнал 48,
   * заголовок группы — своя (§7.3). Высоты фиксированы, строки не прыгают.
   */
  getItemHeight: (item: Item) => number
  /** Строки, на которые нельзя встать (заголовки групп). */
  isSelectable?: (item: Item) => boolean
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  onOpen?: (item: Item, index: number) => void
  onPreview?: (item: Item, index: number) => void
  label: string
  initialScrollOffset?: number
  onScrollOffsetChange?: (offset: number) => void
  /**
   * Строка, на которую экран ставит фокус сам: следующий случай после решения, случай из
   * адреса. Фокус и прокрутка идут за ней, стрелки продолжают от неё.
   */
  focusKey?: string | null
  className?: string
}

/** Виртуальный список строк с той же клавиатурой и выделением, что у сетки (§3.3). */
export function VirtualList<Item>({
  items,
  getKey,
  renderItem,
  getItemHeight,
  isSelectable,
  selectedKeys,
  onSelectedKeysChange,
  onOpen,
  onPreview,
  label,
  initialScrollOffset,
  onScrollOffsetChange,
  focusKey = null,
  className,
}: VirtualListProps<Item>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const keys = useMemo(() => items.map(getKey), [items, getKey])
  // Высота берётся по самой строке: новый список той же длины (другой фильтр, раскрытое
  // событие вместо заголовка) пересчитывает размеры, потому что меняются ключи.
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys])

  const virtualizer = useVirtualizer({
    count: items.length,
    getItemKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = items[index]
      return item === undefined ? 0 : getItemHeight(item)
    },
    overscan: 8,
    initialOffset: initialScrollOffset,
    onChange: (instance) => onScrollOffsetChange?.(instance.scrollOffset ?? 0),
  })

  const scrollToIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: 'auto' }),
    [virtualizer],
  )
  const selectableAt = useCallback(
    (index: number) => {
      const item = items[index]
      return item !== undefined && (isSelectable?.(item) ?? true)
    },
    [items, isSelectable],
  )
  const navigation = useCollectionNavigation({
    keys,
    columns: 1,
    selectedKeys,
    onSelectedKeysChange,
    scrollToIndex,
    isSelectable: selectableAt,
    onOpen: onOpen ? (index) => callWithItem(items, index, onOpen) : undefined,
    onPreview: onPreview ? (index) => callWithItem(items, index, onPreview) : undefined,
  })

  // Только смена `focusKey` двигает фокус: новые строки и раскрытые группы список не дёргают.
  const focusOn = useEffectEvent((key: string) => {
    const index = keys.indexOf(key)
    if (index >= 0) {
      navigation.setFocus(index)
    }
  })
  useEffect(() => {
    if (focusKey !== null) {
      focusOn(focusKey)
    }
  }, [focusKey])

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
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]
          if (item === undefined) {
            return null
          }
          const key = keys[row.index] ?? String(row.index)
          const state = {
            index: row.index,
            selected: selectedKeys.has(key),
            focused: row.index === navigation.focusIndex,
          }
          const style = { transform: `translateY(${row.start}px)`, height: row.size }
          if (!selectableAt(row.index)) {
            return (
              <div key={key} role="presentation" className="absolute inset-x-0 top-0" style={style}>
                {renderItem(item, state)}
              </div>
            )
          }
          return (
            <CollectionOption
              key={key}
              id={`${listId}-${row.index}`}
              index={row.index}
              selected={state.selected}
              focused={state.focused}
              onItemClick={navigation.handleItemClick}
              onItemDoubleClick={navigation.handleItemDoubleClick}
              className="absolute inset-x-0 top-0 rounded-lg"
              style={style}
            >
              {renderItem(item, state)}
            </CollectionOption>
          )
        })}
      </div>
    </div>
  )
}
