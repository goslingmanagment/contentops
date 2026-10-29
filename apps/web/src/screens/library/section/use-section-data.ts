import {
  type CatalogEntry,
  type IntegrationLine,
  type IntegrationView,
  type LocalDate,
  type Model,
  mskDate,
} from '@contentops/contracts'
import { useMemo } from 'react'
import { useClock } from '@/data/api-session'
import { useCatalogIndex, usePageSummaries, useTags } from '@/data/catalog'
import { useIntegrations } from '@/data/integrations'
import type { CatalogFilters } from '../search'
import { filterEntries, whereConditions } from '../shared/catalog-filters'
import type { TileHint } from '../shared/tile-hint'
import { SECTION_CONFIG, type SectionType } from './section-config'
import { type SectionSort, sortEntries } from './section-sort'

/** Ответ под плиткой: страница чипа «Где залито», иначе страница сортировки. */
function hintOf(
  model: Model,
  filters: CatalogFilters,
  sort: SectionSort,
  today: LocalDate,
): TileHint | null {
  const [condition] = whereConditions(filters)
  const code = condition?.account ?? sort.account
  const account = model.accounts.find((candidate) => candidate.code === code)
  if (!account) {
    return null
  }
  return { kind: !condition && sort.base === 'best' ? 'views' : 'page', account, today }
}

/**
 * Строка интеграции (DESIGN §3.2, §3.11) — только когда ответ под плиткой зависит от
 * страницы, где Hub сейчас не работает: иначе янтарь зовёт зря.
 */
function pageLineOf(
  integrations: readonly IntegrationView[] | undefined,
  hint: TileHint | null,
): IntegrationLine | null {
  const hub = integrations?.find(
    (integration) => integration.kind === 'hub' && integration.account === hint?.account.code,
  )
  return hub && hub.state !== 'working' ? hub.line : null
}

/**
 * Раздел-тип по индексу модели в браузере (DESIGN §3.13, §4.2): фильтры, сортировка и
 * смена типа — без запроса. Сводка по страницам — второй ресурс со своим ETag.
 */
export function useSectionData(
  model: Model,
  type: SectionType,
  filters: CatalogFilters,
  sort: SectionSort,
) {
  const index = useCatalogIndex(model.code)
  const summaries = usePageSummaries(model.code)
  const tags = useTags()
  const integrations = useIntegrations()
  const clock = useClock()
  const today = mskDate(clock.now())

  const all = useMemo(
    () => index.data?.items.filter((entry) => entry.type === type) ?? [],
    [index.data, type],
  )
  const visible = useMemo(
    () =>
      sortEntries(filterEntries(all, filters, { summaries: summaries.data, today }), sort, {
        summaries: summaries.data,
        numberOrder: SECTION_CONFIG[type].numberOrder,
      }),
    [all, filters, sort, summaries.data, today, type],
  )
  const collections = useMemo<CatalogEntry[]>(
    () =>
      (index.data?.items ?? [])
        .filter((entry) => entry.type === 'promo')
        .sort((left, right) => right.arrived_on.localeCompare(left.arrived_on)),
    [index.data],
  )
  const hint = useMemo(() => hintOf(model, filters, sort, today), [model, filters, sort, today])
  const pageLine = useMemo(() => pageLineOf(integrations.data, hint), [integrations.data, hint])

  return { index, summaries, tags: tags.data, all, visible, collections, pageLine, hint }
}
