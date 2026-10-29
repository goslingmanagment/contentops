import { EventRowSkeleton } from '@contentops/ui/components/event-row'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { useClock } from '@/data/api-session'
import { useJournal } from '@/data/journal'
import { useRole } from '@/data/session'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { JournalChips } from './journal-chips'
import { useJournalEventMenu } from './journal-event-menu'
import { JournalFeed } from './journal-feed'
import {
  hasJournalFilters,
  journalFilterKey,
  journalFilterOf,
  NO_JOURNAL_FILTERS,
} from './journal-filter'
import type { JournalSearch } from './search'
import { useJournalContext } from './use-journal-context'

const routeApi = getRouteApi('/_shell/$model/journal')

const SKELETON_ROWS = 12

/**
 * Журнал `#/<модель>/journal` (DESIGN §4.18): кто что куда перенёс и когда. Лента по
 * дням, чипы как в «Истории» Я.Диска, раскрытие «было → стало». Фильтры — в адресе,
 * агент читает тот же `GET …/journal`.
 */
export function JournalScreen() {
  const model = useCurrentModel()
  const search = routeApi.useSearch()
  const navigate = useNavigate({ from: '/$model/journal' })
  const role = useRole()
  const clock = useClock()
  const context = useJournalContext(journalFilterKey(search))

  // «Сейчас» берётся один раз на фильтр: период «сегодня» не сдвигается на каждой отрисовке.
  const filter = useMemo(() => journalFilterOf(search, clock.now()), [search, clock])
  const journal = useJournal(model.code, filter, { keepPreviousFilter: true })
  const events = useMemo(
    () => journal.data?.pages.flatMap((page) => page.items) ?? null,
    [journal.data],
  )

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = journal
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const changeFilters = (patch: Partial<JournalSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
  }
  const resetFilters = () => changeFilters(NO_JOURNAL_FILTERS)

  const menuOf = useJournalEventMenu(model.code, (item) =>
    changeFilters({ ...NO_JOURNAL_FILTERS, item }),
  )

  const filtered = hasJournalFilters(search)
  const pending = journal.isPending
  const failedWithoutData = journal.isError && events === null

  return (
    <FieldLayout>
      <FieldHeader title="Журнал" meta={model.name} />
      <JournalChips search={search} role={role} onChange={changeFilters} onReset={resetFilters} />
      <RefreshStrip active={journal.isFetching && !pending && !isFetchingNextPage} />
      {events !== null ? <QueryErrorLine query={journal} /> : null}
      {pending ? <JournalSkeleton /> : null}
      {failedWithoutData ? (
        <ErrorLine
          layout="center"
          message="Не загрузилось"
          onRetry={() => void journal.refetch()}
        />
      ) : null}
      {events !== null && events.length === 0 ? (
        filtered ? (
          <EmptyState action={{ label: 'Сбросить', onSelect: resetFilters }}>
            По этим фильтрам ничего
          </EmptyState>
        ) : (
          <EmptyState>Событий пока нет</EmptyState>
        )
      ) : null}
      {events !== null && events.length > 0 ? (
        <JournalFeed
          key={journalFilterKey(search)}
          events={events}
          model={model.code}
          now={clock.now()}
          hasMore={hasNextPage}
          loadMore={loadMore}
          context={context}
          menuOf={menuOf}
        />
      ) : null}
    </FieldLayout>
  )
}

function JournalSkeleton() {
  return (
    <div aria-busy className="flex flex-col pt-11">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <EventRowSkeleton key={index} />
      ))}
    </div>
  )
}
