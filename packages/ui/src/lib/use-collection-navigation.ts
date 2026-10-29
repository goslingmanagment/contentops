import { type KeyboardEvent, type MouseEvent, useCallback, useState } from 'react'
import {
  clickSelection,
  keyMove,
  type MoveMode,
  moveModeOf,
  nearestSelectable,
} from './collection-moves'
import { hasModifierKey, isTypingTarget } from './platform'
import { clampIndex, selectOnly, selectRange, toggleKey } from './selection'

interface CollectionNavigationOptions {
  /** Ключи всех элементов по порядку (индекс модели целиком, а не только видимые). */
  keys: readonly string[]
  /** Число колонок: стрелки вверх и вниз прыгают на ряд. У списка — 1. */
  columns: number
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  /** Прокрутить к элементу: у виртуального списка — `scrollToIndex`. */
  scrollToIndex: (index: number) => void
  /** Можно ли встать на элемент (заголовки групп — нельзя). */
  isSelectable?: (index: number) => boolean
  onOpen?: (index: number) => void
  onPreview?: (index: number) => void
  initialFocusIndex?: number
  /**
   * Куда встать стрелкой вверх или вниз. По умолчанию — на ряд выше или ниже (±`columns`);
   * у сетки с группами ряды разной длины, и она считает соседний ряд сама.
   */
  verticalTarget?: (index: number, direction: 1 | -1) => number
}

export interface CollectionNavigation {
  focusIndex: number
  /** Поставить фокус на элемент без выделения: `1` и `3` в сете ведут фокус дальше. */
  setFocus: (index: number) => void
  handleItemClick: (index: number, event: MouseEvent) => void
  handleItemDoubleClick: (index: number) => void
  handleKeyDown: (event: KeyboardEvent) => void
}

/**
 * Клавиатура и мышь для сеток и списков (DESIGN §3.3, §3.12). Фокус держится номером
 * элемента и доводится прокруткой, а не DOM-узлом, который виртуальный список выгружает.
 * Клавиши слушаются по `code`, поэтому работают и в русской раскладке.
 */
export function useCollectionNavigation({
  keys,
  columns,
  selectedKeys,
  onSelectedKeysChange,
  scrollToIndex,
  isSelectable = () => true,
  onOpen,
  onPreview,
  initialFocusIndex = 0,
  verticalTarget,
}: CollectionNavigationOptions): CollectionNavigation {
  const [focusIndex, setFocusIndex] = useState(initialFocusIndex)
  const [anchorIndex, setAnchorIndex] = useState(initialFocusIndex)
  const count = keys.length

  const findSelectable = useCallback(
    (start: number, step: number): number =>
      nearestSelectable(start, step, count, isSelectable, focusIndex),
    [count, focusIndex, isSelectable],
  )

  const neighbourRow = useCallback(
    (index: number, direction: 1 | -1) =>
      verticalTarget ? verticalTarget(index, direction) : index + direction * columns,
    [columns, verticalTarget],
  )

  /** Фокус не стоит на заголовке группы, даже если список начинается с него. */
  const clampedFocus = clampIndex(focusIndex, count)
  const currentFocus = isSelectable(clampedFocus) ? clampedFocus : findSelectable(clampedFocus, 1)

  const moveFocus = useCallback(
    (target: number, step: number, mode: MoveMode) => {
      const index = findSelectable(target, step)
      setFocusIndex(index)
      scrollToIndex(index)
      if (mode === 'select') {
        setAnchorIndex(index)
        onSelectedKeysChange(selectOnly(keys, index))
      } else if (mode === 'extend') {
        onSelectedKeysChange(selectRange(keys, anchorIndex, index))
      }
    },
    [anchorIndex, findSelectable, keys, onSelectedKeysChange, scrollToIndex],
  )

  const handleItemClick = useCallback(
    (index: number, event: MouseEvent) => {
      setFocusIndex(index)
      const next = clickSelection({
        keys,
        selected: selectedKeys,
        anchor: anchorIndex,
        index,
        shiftKey: event.shiftKey,
        modifier: hasModifierKey(event),
      })
      setAnchorIndex(next.anchor)
      onSelectedKeysChange(next.selected)
    },
    [anchorIndex, keys, onSelectedKeysChange, selectedKeys],
  )

  const handleItemDoubleClick = useCallback((index: number) => onOpen?.(index), [onOpen])

  const setFocus = useCallback(
    (index: number) => {
      const clamped = clampIndex(index, count)
      setFocusIndex(clamped)
      scrollToIndex(clamped)
    },
    [count, scrollToIndex],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (count === 0 || isTypingTarget(event.target)) {
        return
      }
      const modifier = hasModifierKey(event)
      const mode = moveModeOf(event.shiftKey, modifier)
      const move = keyMove(event.code, currentFocus, count, neighbourRow)
      if (move) {
        event.preventDefault()
        moveFocus(move[0], move[1], mode)
        return
      }
      if (event.code === 'KeyA' && modifier) {
        event.preventDefault()
        onSelectedKeysChange(new Set(keys.filter((_, index) => isSelectable(index))))
        return
      }
      if (event.code === 'Escape' && selectedKeys.size > 0) {
        event.preventDefault()
        onSelectedKeysChange(new Set())
        return
      }
      if (event.code === 'Enter' && onOpen) {
        event.preventDefault()
        onOpen(currentFocus)
        return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        if (onPreview) {
          onPreview(currentFocus)
        } else {
          onSelectedKeysChange(toggleKey(selectedKeys, keys[currentFocus]))
        }
      }
    },
    [
      count,
      currentFocus,
      isSelectable,
      keys,
      moveFocus,
      neighbourRow,
      onOpen,
      onPreview,
      onSelectedKeysChange,
      selectedKeys,
    ],
  )

  return {
    focusIndex: currentFocus,
    setFocus,
    handleItemClick,
    handleItemDoubleClick,
    handleKeyDown,
  }
}
