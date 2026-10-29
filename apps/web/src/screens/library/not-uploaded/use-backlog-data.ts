import type { Account, CatalogEntry, Instant, Model } from '@contentops/contracts'
import { useMemo } from 'react'
import { useCatalogIndex, useNotUploadedPages, usePageSummaries, useTags } from '@/data/catalog'
import { useIntegrations } from '@/data/integrations'
import { type PageBacklog, pageBacklog } from '../shared/not-uploaded-index'
import { backlogCount } from './backlog'

export interface BacklogTab {
  account: Account
  /** Без фупов; `null`, пока индекс не пришёл. */
  count: number | null
}

/**
 * Данные «Ещё не залито» (DESIGN §4.3, §3.13): списки и числа вкладок — из индекса в
 * браузере, строка покрытия и строка Hub — из ответа страницы (все вкладки запрошены
 * сразу, поэтому при переключении ничего не въезжает).
 */
export function useBacklogData(model: Model, account: Account) {
  const index = useCatalogIndex(model.code)
  const summaries = usePageSummaries(model.code)
  const tags = useTags()
  const integrations = useIntegrations()
  const codes = useMemo(() => model.accounts.map((candidate) => candidate.code), [model.accounts])
  const pages = useNotUploadedPages(model.code, codes)

  const backlogs = useMemo(() => {
    if (!index.data || !summaries.data) {
      return null
    }
    const items = index.data.items
    const view = summaries.data
    return new Map(
      model.accounts.map((candidate) => [candidate.code, pageBacklog(items, view, candidate)]),
    )
  }, [index.data, summaries.data, model.accounts])

  const backlog: PageBacklog | undefined = backlogs?.get(account.code)
  const tabs = useMemo<BacklogTab[]>(
    () =>
      model.accounts.map((candidate) => {
        const found = backlogs?.get(candidate.code)
        return { account: candidate, count: found ? backlogCount(found) : null }
      }),
    [backlogs, model.accounts],
  )

  const page = pages[codes.indexOf(account.code)]
  const hub = integrations.data?.find(
    (integration) => integration.kind === 'hub' && integration.account === account.code,
  )
  /** «числа на 13:52»: Hub этой страницы сейчас не отвечает, показано последнее известное. */
  const asOf: Instant | null =
    hub && (hub.state === 'down' || hub.state === 'catching_up') ? hub.last_ok_at : null

  const collections = useMemo<CatalogEntry[]>(
    () => (index.data?.items ?? []).filter((entry) => entry.type === 'promo'),
    [index.data],
  )

  return {
    index,
    summaries,
    tags: tags.data,
    backlog,
    tabs,
    coverageNote: page?.data?.coverage_note ?? null,
    integration: page?.data?.integration ?? null,
    asOf,
    /** Страница ответила или не смогла: дальше ждать строк незачем. */
    linesSettled: page === undefined || page.isSuccess || page.isError,
    collections,
  }
}
