import { clampIndex, selectOnly, selectRange, toggleKey } from './selection'

/**
 * Чистые правила клавиш и щелчков в сетках и списках (DESIGN §3.3, §3.12): куда встаёт
 * фокус и что становится выделенным. Хук `useCollectionNavigation` только хранит
 * состояние и зовёт их.
 */

/** Стрелка без клавиш — выбрать, с `Shift` — расширить, с `Ctrl`/`⌘` — только фокус. */
export type MoveMode = 'select' | 'extend' | 'focus'

export function moveModeOf(shiftKey: boolean, modifier: boolean): MoveMode {
  return shiftKey ? 'extend' : modifier ? 'focus' : 'select'
}

/** Цель и направление поиска для клавиши (`KeyboardEvent.code`); `undefined` — не наша. */
export function keyMove(
  code: string,
  focus: number,
  count: number,
  neighbourRow: (index: number, direction: 1 | -1) => number,
): readonly [target: number, step: 1 | -1] | undefined {
  switch (code) {
    case 'ArrowRight':
      return [focus + 1, 1]
    case 'ArrowLeft':
      return [focus - 1, -1]
    case 'ArrowDown':
      return [neighbourRow(focus, 1), 1]
    case 'ArrowUp':
      return [neighbourRow(focus, -1), -1]
    case 'Home':
      return [0, 1]
    case 'End':
      return [count - 1, -1]
    default:
      return undefined
  }
}

/**
 * Ближайший элемент, на который можно встать, от `start` в сторону `step` (заголовки
 * групп пропускаются); если такого нет — остаётся `fallback`.
 */
export function nearestSelectable(
  start: number,
  step: number,
  count: number,
  isSelectable: (index: number) => boolean,
  fallback: number,
): number {
  let index = clampIndex(start, count)
  while (index >= 0 && index < count && !isSelectable(index)) {
    index += step > 0 ? 1 : -1
  }
  return index >= 0 && index < count ? index : clampIndex(fallback, count)
}

interface ClickInput {
  keys: readonly string[]
  selected: ReadonlySet<string>
  anchor: number
  index: number
  shiftKey: boolean
  modifier: boolean
}

/**
 * Щелчок: простой — один элемент и новая опора; `Ctrl`/`⌘` — добавить или убрать один;
 * `Shift` — диапазон от опоры (с `Ctrl`/`⌘` — к прежнему выделению), опора не двигается.
 */
export function clickSelection({ keys, selected, anchor, index, shiftKey, modifier }: ClickInput): {
  selected: Set<string>
  anchor: number
} {
  if (shiftKey) {
    return { selected: selectRange(keys, anchor, index, modifier ? selected : undefined), anchor }
  }
  if (modifier) {
    return { selected: toggleKey(selected, keys[index]), anchor: index }
  }
  return { selected: selectOnly(keys, index), anchor: index }
}
