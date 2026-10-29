import { type RefObject, useLayoutEffect, useState } from 'react'

/** Есть ли скрытое прокруткой содержимое до и после видимой части ряда. */
export interface ScrollEdges {
  before: boolean
  after: boolean
}

const NONE: ScrollEdges = { before: false, after: false }

/**
 * Края горизонтального ряда с прокруткой: пересчёт при прокрутке и при изменении размера
 * ряда или его содержимого (чип стал длиннее, открылась панель). `content` — обёртка
 * шириной по содержимому (`w-max`), иначе рост чипов не виден наблюдателю.
 */
export function useScrollEdges(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NONE)
  useLayoutEffect(() => {
    const element = scroller.current
    const inner = content.current
    if (!element || !inner) {
      return
    }
    const measure = () => {
      const hidden = element.scrollWidth - element.clientWidth
      const before = element.scrollLeft > 1
      const after = element.scrollLeft < hidden - 1
      setEdges((current) =>
        current.before === before && current.after === after ? current : { before, after },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(inner)
    element.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', measure)
    }
  }, [scroller, content])
  return edges
}
