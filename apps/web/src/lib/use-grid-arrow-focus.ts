import { type KeyboardEvent, type RefObject, useCallback } from 'react'

const STEP_BY_KEY: Readonly<Record<string, 'left' | 'right' | 'up' | 'down' | 'home' | 'end'>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
}

/** Число колонок CSS-сетки по её вычисленному шаблону. */
function columnsOf(grid: HTMLElement): number {
  const template = getComputedStyle(grid).gridTemplateColumns
  return Math.max(1, template.split(' ').filter(Boolean).length)
}

/**
 * Стрелки между ссылками в сетке (папки корня Библиотеки, DESIGN §4.1): фокус ходит по
 * плиткам, `Enter` открывает ссылку сам. Шаг вверх и вниз — на ряд.
 */
export function useGridArrowFocus(gridRef: RefObject<HTMLElement | null>, itemSelector: string) {
  return useCallback(
    (event: KeyboardEvent) => {
      const step = STEP_BY_KEY[event.key]
      const grid = gridRef.current
      if (!step || !grid) {
        return
      }
      const items = Array.from(grid.querySelectorAll<HTMLElement>(itemSelector))
      const active = document.activeElement
      const current = active instanceof HTMLElement ? items.indexOf(active) : -1
      if (current < 0) {
        return
      }
      const columns = columnsOf(grid)
      const targets = {
        left: current - 1,
        right: current + 1,
        up: current - columns,
        down: current + columns,
        home: 0,
        end: items.length - 1,
      }
      const target = items[Math.min(items.length - 1, Math.max(0, targets[step]))]
      if (target) {
        event.preventDefault()
        target.focus()
      }
    },
    [gridRef, itemSelector],
  )
}
