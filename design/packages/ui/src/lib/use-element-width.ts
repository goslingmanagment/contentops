import { type RefObject, useLayoutEffect, useState } from 'react'

/** Ширина содержимого без внутренних полей — то же, что даёт `ResizeObserver`. */
function contentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element)
  return (
    element.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight)
  )
}

/**
 * Ширина содержимого элемента с пересчётом при изменении размера окна или панели. Первое
 * измерение и последующие считаются одинаково, поэтому сетка не перестраивается после
 * первого кадра.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    setWidth(contentWidth(element))
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setWidth(entry.contentRect.width)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}
