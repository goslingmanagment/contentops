import { useLayoutEffect, useState } from 'react'

/**
 * Есть ли ниже видимой части ещё поля: тогда подвал окна отбрасывает тень, и видно, что
 * окно прокручивается. Пересчёт — при прокрутке и при изменении размера окна или полей
 * (текст карточки свернулся, выросло ТЗ, появилась ошибка под полем). Ссылки — функции:
 * содержимое окна появляется только при открытии, позже самого хука.
 */
export function useContentBelow() {
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [content, setContent] = useState<HTMLElement | null>(null)
  const [below, setBelow] = useState(false)
  useLayoutEffect(() => {
    if (!scroller || !content) return
    const measure = () => {
      setBelow(scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(content)
    scroller.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', measure)
    }
  }, [scroller, content])
  return { scrollerRef: setScroller, contentRef: setContent, below }
}
