import type { ReactNode } from 'react'

/** Нажатие внутри строки не выбирает её: у ссылки или кнопки в строке своё действие. */
export function stopRowClick(event: { stopPropagation: () => void }): void {
  event.stopPropagation()
}

/**
 * Кнопки и «почему» в строке решают сами: их нажатие не выделяет строку и не открывает
 * панель. Обёртка без своего места (`display: contents`), поэтому пустое место строки
 * по-прежнему выделяет её.
 */
export function StopRowClick({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: только гасит всплытие нажатия к строке списка
    // biome-ignore lint/a11y/useKeyWithClickEvents: клавиши строки обрабатывает список-владелец
    <span className="contents" onClick={stopRowClick}>
      {children}
    </span>
  )
}
