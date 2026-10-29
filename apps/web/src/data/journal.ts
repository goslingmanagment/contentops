import type { JournalFilter, ModelCode } from '@contentops/contracts'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

interface JournalOptions {
  /**
   * При смене фильтра прежняя лента той же модели остаётся на экране, пока не пришла
   * новая: поле Журнала не мигает заготовками. Чужой модели и чужого объекта не держим.
   */
  keepPreviousFilter?: boolean
}

/** Лента журнала по курсору; фильтры — как у `GET …/journal`. */
export function useJournal(
  model: ModelCode,
  filter: JournalFilter = {},
  { keepPreviousFilter = false }: JournalOptions = {},
) {
  const api = useApi()
  const modelKey = queryKeys.model(model)
  return useInfiniteQuery({
    queryKey: queryKeys.journal(model, JSON.stringify(filter)),
    queryFn: ({ pageParam, signal }) =>
      api.journal.list({
        params: { model },
        query: { ...filter, cursor: pageParam ?? undefined },
        signal,
      }),
    // Лента живая: каждый вход перечитывает её в фоне, показывая то, что уже есть в кэше.
    staleTime: 0,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    placeholderData: (previous, previousQuery) =>
      keepPreviousFilter && previousQuery?.queryKey[1] === modelKey[1] ? previous : undefined,
  })
}
