import type { PlanRow } from '@contentops/contracts'
import type { MouseEvent } from 'react'
import { useRef } from 'react'
import { useRowSelection } from '../shared/use-row-selection'

/**
 * Выделение строк недели (DESIGN §3.3): клик — одна строка, `Ctrl`/`⌘` — точечно,
 * `Shift` — диапазон в порядке недели (дни, страницы, время).
 */
export function useWeekSelection(order: readonly PlanRow[]) {
  const selection = useRowSelection('plan-week:selection')
  const anchor = useRef<string | null>(null)

  const selectRow = (row: PlanRow, event: MouseEvent) => {
    const current = selection.selectedKeys
    if (event.shiftKey && anchor.current) {
      const ids = order.map((candidate) => candidate.id)
      const from = ids.indexOf(anchor.current)
      const to = ids.indexOf(row.id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        selection.setSelectedKeys(new Set(ids.slice(start, end + 1)))
        return
      }
    }
    anchor.current = row.id
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(current)
      if (next.has(row.id)) {
        next.delete(row.id)
      } else {
        next.add(row.id)
      }
      selection.setSelectedKeys(next)
      return
    }
    selection.setSelectedKeys(new Set([row.id]))
  }

  const selectRows = (rowIds: readonly string[]) => {
    anchor.current = rowIds[0] ?? null
    selection.setSelectedKeys(new Set(rowIds))
  }

  return { selectedKeys: selection.selectedKeys, selectRow, selectRows, clear: selection.clear }
}
