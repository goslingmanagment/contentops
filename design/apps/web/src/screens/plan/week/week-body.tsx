import type { Account, AccountCode, LocalDate, PlanWeek } from '@contentops/contracts'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import type { UseQueryResult } from '@tanstack/react-query'
import type { GridHandlers } from './week-grid'
import { WeekGrid } from './week-grid'
import { WeekPages } from './week-pages'
import { WeekSkeleton } from './week-skeleton'

interface WeekBodyProps {
  query: UseQueryResult<PlanWeek>
  accounts: readonly Account[]
  today: LocalDate
  selectedKeys: ReadonlySet<string>
  canAct: boolean
  handlers: GridHandlers
  /** Второй вид `?variant=pages`: страница на вкладке. */
  pagesVariant: { page: Account; onPageChange: (page: AccountCode) => void } | null
}

/** Тело недели (DESIGN §3.10, §4.12): заготовки, ошибка, пустая неделя, таблица или второй вид. */
export function WeekBody({
  query,
  accounts,
  today,
  selectedKeys,
  canAct,
  handlers,
  pagesVariant,
}: WeekBodyProps) {
  const data = query.data
  const empty = data !== undefined && data.rows.length === 0 && data.gaps.length === 0
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-8">
      {query.isError && data ? (
        <ErrorLine
          message="Не удалось обновить — показана прежняя неделя"
          onRetry={() => void query.refetch()}
          className="mb-2"
        />
      ) : null}
      {query.isError && !data ? (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void query.refetch()} />
      ) : null}
      {query.isPending && !query.isError ? <WeekSkeleton pages={accounts.length} /> : null}
      {empty ? <EmptyState>На этой неделе ничего не стоит и нормы нет</EmptyState> : null}
      {data && !empty && pagesVariant ? (
        <WeekPages
          week={data}
          accounts={accounts}
          page={pagesVariant.page}
          onPageChange={pagesVariant.onPageChange}
          today={today}
          selectedKeys={selectedKeys}
          canAct={canAct}
          handlers={handlers}
        />
      ) : null}
      {data && !empty && !pagesVariant ? (
        <WeekGrid
          week={data}
          accounts={accounts}
          today={today}
          selectedKeys={selectedKeys}
          canAct={canAct}
          handlers={handlers}
        />
      ) : null}
    </div>
  )
}
