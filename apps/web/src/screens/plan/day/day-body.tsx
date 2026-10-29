import type { PlanDay } from '@contentops/contracts'
import { EmptyState } from '@contentops/ui/components/state-lines'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { DayListView } from './day-list-view'
import { DaySkeleton } from './day-skeleton'

interface DayBodyProps {
  query: UseQueryResult<PlanDay>
  /** «Поставить в план» в пустом дне; нет у «только чтение». */
  onPlan: (() => void) | null
  list: ComponentProps<typeof DayListView>
}

/**
 * Тело дня (DESIGN §3.10): заготовки на первой загрузке, строка ошибки над списком или по
 * центру, пустой день одной строкой, иначе список.
 */
export function DayBody({ query, onPlan, list }: DayBodyProps) {
  const data = query.data
  const empty = data !== undefined && data.rows.length === 0 && data.gaps.length === 0
  return (
    <div className="-mx-7 flex min-h-0 flex-1 flex-col px-7 pt-1">
      <QueryErrorLine query={query} hasData={data !== undefined} className="mb-2" />
      {query.isPending && !query.isError ? <DaySkeleton /> : null}
      {empty ? (
        <EmptyState action={onPlan ? { label: 'Поставить в план', onSelect: onPlan } : undefined}>
          На этот день ничего не стоит
        </EmptyState>
      ) : null}
      {data && !empty ? <DayListView {...list} /> : null}
    </div>
  )
}
