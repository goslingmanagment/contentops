import type { Account, AccountCode, PlanDay } from '@contentops/contracts'
import { useMemo } from 'react'
import { useRowSelection } from '../shared/use-row-selection'
import { buildDayList, rowsOfItem } from './day-list'

interface DayItemsOptions {
  accounts: readonly Account[]
  pages: readonly AccountCode[]
  mineOf: string | null
  byTime: boolean
}

/**
 * Строки дня списком и их выделение: выделяются элементы списка (слитая строка — одна),
 * а наружу отдаются строки плана за ними.
 */
export function useDayItems(day: PlanDay | undefined, options: DayItemsOptions) {
  const { accounts, pages, mineOf, byTime } = options
  const selection = useRowSelection('plan-day:selection')
  const items = useMemo(
    () => (day ? buildDayList(day, { accounts, pages, mineOf, byTime }) : []),
    [day, accounts, pages, mineOf, byTime],
  )
  const selectedRows = useMemo(
    () => items.filter((item) => selection.selectedKeys.has(item.key)).flatMap(rowsOfItem),
    [items, selection.selectedKeys],
  )
  const selectRows = (rowIds: readonly string[]) =>
    selection.setSelectedKeys(
      new Set(
        items
          .filter((item) => rowsOfItem(item).some((row) => rowIds.includes(row.id)))
          .map((item) => item.key),
      ),
    )
  return { items, selection, selectedRows, selectRows }
}
