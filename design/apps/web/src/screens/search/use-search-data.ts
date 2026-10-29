import { type CatalogEntry, type ItemId, type Model, parseIdQuery } from '@contentops/contracts'
import { useMemo } from 'react'
import { usePageSummaries, useTags } from '@/data/catalog'
import { useFoundObjects } from '@/data/search'

function entriesOf(
  ids: readonly ItemId[],
  byId: ReadonlyMap<ItemId, CatalogEntry> | undefined,
): CatalogEntry[] {
  return ids.flatMap((id) => {
    const entry = byId?.get(id)
    return entry ? [entry] : []
  })
}

/**
 * Поиск (DESIGN §4.7, §3.13): индекс в браузере отвечает сразу — ID, названия, старые
 * номера, теги, формы слов, слова-типы и слова чаттеров; сервер дописывает описания,
 * старые имена, хронологию и черновики «Приехало». Пока сервер думает, его группы стоят
 * заготовками.
 */
export function useSearchData(model: Model, query: string) {
  const summaries = usePageSummaries(model.code)
  const tags = useTags()
  const { index, server, found } = useFoundObjects(model.code, query)
  const byId = index.data?.byId

  // «ппв 73», «[PPV-073]», «cus183»: строка «ппв 73 → PPV-073» над результатами.
  const exact = useMemo(() => {
    const id = parseIdQuery(query)
    return id ? byId?.get(id) : undefined
  }, [query, byId])
  const resolve = server.data?.resolve
  const oldNumber = useMemo(
    () =>
      resolve?.old_number
        ? { number: resolve.old_number.number, entries: entriesOf(resolve.old_number.items, byId) }
        : null,
    [resolve, byId],
  )
  const collections = useMemo<CatalogEntry[]>(
    () => (index.data?.items ?? []).filter((entry) => entry.type === 'promo'),
    [index.data],
  )

  return {
    index,
    summaries,
    tags: tags.data,
    server,
    found,
    /** Запрос разобран как ID: «ппв 73 → PPV-073». */
    parsedId: exact?.id ?? null,
    oldNumber,
    timeline: server.data?.timeline ?? [],
    drafts: server.data?.inbox ?? [],
    byId,
    collections,
  }
}
