import { useCallback, useMemo, useState } from 'react'
import { z } from 'zod'
import { useHistoryScroll, useHistoryState } from '@/lib/use-history-state'

const StoredSchema = z.object({
  /** Фильтры, при которых раскрывали и выбирали: при других это ни к чему. */
  filter: z.string(),
  expanded: z.array(z.string()),
  selected: z.array(z.string()),
})
type Stored = z.infer<typeof StoredSchema>

const NOTHING: Stored = { filter: '', expanded: [], selected: [] }

/** Что лента помнит между переходами и что умеет с этим делать. */
export interface JournalContext {
  expanded: ReadonlySet<string>
  toggle: (id: string) => void
  selectedKeys: ReadonlySet<string>
  setSelectedKeys: (next: ReadonlySet<string>) => void
  initialScrollOffset: number | undefined
  onScrollOffsetChange: (offset: number) => void
}

/**
 * Контекст ленты в записи истории (DESIGN §2.4, §3.13): раскрытые события, текущая
 * строка и прокрутка. «Назад» из объекта возвращает ленту такой, какой её оставили.
 *
 * Контекст привязан к фильтрам, а не сбрасывается при их смене: запись в историю в
 * момент перехода маршрутизатора сбила бы сам переход.
 */
export function useJournalContext(filterKey: string): JournalContext {
  const [stored, setStored] = useHistoryState('journal:context', StoredSchema, () => NOTHING)
  const scroll = useHistoryScroll('journal:scroll')
  const [filterOnEntry] = useState(filterKey)
  const current = stored.filter === filterKey ? stored : { ...NOTHING, filter: filterKey }

  const expanded = useMemo(() => new Set(current.expanded), [current.expanded])
  const selectedKeys = useMemo(() => new Set(current.selected), [current.selected])

  const toggle = useCallback(
    (id: string) =>
      setStored((previous) => {
        const base = previous.filter === filterKey ? previous : { ...NOTHING, filter: filterKey }
        const expandedNow = base.expanded.includes(id)
          ? base.expanded.filter((key) => key !== id)
          : [...base.expanded, id]
        return { ...base, expanded: expandedNow }
      }),
    [filterKey, setStored],
  )
  const setSelectedKeys = useCallback(
    (next: ReadonlySet<string>) =>
      setStored((previous) => ({
        ...(previous.filter === filterKey ? previous : { ...NOTHING, filter: filterKey }),
        selected: [...next],
      })),
    [filterKey, setStored],
  )

  return {
    expanded,
    toggle,
    selectedKeys,
    setSelectedKeys,
    /** Прокрутка возвращается только в ту ленту, из которой ушли. */
    initialScrollOffset: filterKey === filterOnEntry ? scroll.initialOffset : undefined,
    onScrollOffsetChange: scroll.onScrollOffsetChange,
  }
}
