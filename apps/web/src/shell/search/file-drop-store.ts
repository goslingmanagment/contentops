import { useSyncExternalStore } from 'react'

/**
 * Файлы держат над строкой поиска (DESIGN §4.7): подсказка поверх окна говорит «найдём такой
 * же файл», а не «откроется загрузка».
 */
let over = false
const listeners = new Set<() => void>()

export function setFileOverSearch(value: boolean) {
  if (over === value) return
  over = value
  for (const listener of listeners) listener()
}

export function useFileOverSearch(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => over,
  )
}
