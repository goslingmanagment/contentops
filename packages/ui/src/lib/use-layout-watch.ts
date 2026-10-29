import { useEffect, useState } from 'react'

/**
 * Значение из раскладки страницы, которое пересчитывается, когда она меняется: элементы
 * появились или ушли, окно изменилось, закончилась анимация сдвига. Меряет не чаще раза
 * за кадр. `measure` должна быть стабильной (вне компонента или из `useCallback`).
 */
export function useLayoutWatch<T>(measure: () => T, initial: T, enabled = true): T {
  const [value, setValue] = useState(initial)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let frame = 0
    const run = () => {
      frame = 0
      setValue(measure())
    }
    const schedule = () => {
      frame ||= requestAnimationFrame(run)
    }
    run()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('transitionend', schedule, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('transitionend', schedule, true)
    }
  }, [measure, enabled])
  return value
}
