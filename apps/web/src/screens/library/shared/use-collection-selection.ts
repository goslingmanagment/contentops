import { useCallback, useMemo } from 'react'
import { z } from 'zod'
import { useHistoryState } from '@/lib/use-history-state'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'

const SelectionSchema = z.array(z.string())

/**
 * Выделение списка Библиотеки (DESIGN §3.3). Ключи живут в записи истории (§2.4): «Назад»
 * из объекта возвращает выделение, в адрес оно не пишется — выделяют и сотни объектов.
 * `selected` — выбранные среди видимых по фильтрам, в их порядке; `Esc` снимает выделение.
 * `getKey` — постоянная функция уровня модуля.
 */
export function useCollectionSelection<T>(
  key: string,
  items: readonly T[],
  getKey: (item: T) => string,
) {
  const [stored, setStored] = useHistoryState(key, SelectionSchema, () => [])
  const selectedKeys = useMemo<ReadonlySet<string>>(() => new Set(stored), [stored])
  const setSelectedKeys = useCallback((next: Iterable<string>) => setStored([...next]), [setStored])
  const clear = useCallback(() => setStored([]), [setStored])
  const selected = useMemo(
    () => items.filter((item) => selectedKeys.has(getKey(item))),
    [items, selectedKeys, getKey],
  )
  useKeyboardShortcut({ code: 'Escape', enabled: selected.length > 0 }, clear)

  const toggle = useCallback(
    (id: string, checked: boolean) => {
      const next = new Set(selectedKeys)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      setSelectedKeys(next)
    },
    [selectedKeys, setSelectedKeys],
  )
  const selectAll = useCallback(
    () => setSelectedKeys(items.map(getKey)),
    [items, getKey, setSelectedKeys],
  )

  return { selectedKeys, setSelectedKeys, clear, selected, toggle, selectAll }
}
