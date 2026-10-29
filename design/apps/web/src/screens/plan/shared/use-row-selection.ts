import { useCallback, useMemo } from 'react'
import { z } from 'zod'
import { useHistoryState } from '@/lib/use-history-state'

const SelectionSchema = z.array(z.string())

/**
 * Выделение строк плана живёт в записи истории (DESIGN §2.4): «Назад» из объекта
 * возвращает его, в адрес оно не пишется.
 */
export function useRowSelection(key: string) {
  const [stored, setStored] = useHistoryState(key, SelectionSchema, () => [])
  const selectedKeys = useMemo(() => new Set(stored), [stored])
  const setSelectedKeys = useCallback(
    (next: ReadonlySet<string>) => setStored([...next]),
    [setStored],
  )
  const clear = useCallback(() => setStored([]), [setStored])
  return { selectedKeys, setSelectedKeys, clear }
}
