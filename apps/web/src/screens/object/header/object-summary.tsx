import type { CatalogEntry, ItemType, PageSummaryEntry } from '@contentops/contracts'
import { PlacementLine } from '@contentops/ui/components/placement-line'
import { useMemo } from 'react'
import { useToday } from '@/data/api-session'
import { usePageSummaries } from '@/data/catalog'
import { placementEntries } from '@/objects/placement-text'
import { useCurrentModel } from '@/shell/model/model-context'
import { useObjectPage } from '../object-context'
import { entryMetaParts, objectMetaParts } from './object-meta'
import { usePromoMeta } from './use-promo-meta'

/** Кастомы уходят фанам, сырьё и подборки не выкладываются: пустая строка — шум. */
const NOT_POSTED: ReadonlySet<ItemType> = new Set<ItemType>(['custom', 'raw', 'promo'])

function hidePlacement(type: ItemType, summaries: readonly PageSummaryEntry[]): boolean {
  return NOT_POSTED.has(type) && summaries.every((summary) => summary.level === 'unknown')
}

interface SummaryLinesProps {
  meta: readonly string[]
  type: ItemType
  summaries: readonly PageSummaryEntry[]
  activePage?: string
  onSelectPage?: (label: string) => void
}

/** Мета-строка 20 и строка «где залито» 32 по пяти страницам. */
function SummaryLines({ meta, type, summaries, activePage, onSelectPage }: SummaryLinesProps) {
  const today = useToday()
  const { accounts } = useCurrentModel()
  return (
    <div className="flex shrink-0 flex-col gap-1.5 pb-3">
      <p className="truncate text-muted-foreground text-sm tabular-nums">{meta.join(' · ')}</p>
      {hidePlacement(type, summaries) ? null : (
        <PlacementLine
          entries={placementEntries(accounts, summaries, today)}
          activePage={activePage}
          onSelectPage={onSelectPage}
          className="-ml-2"
        />
      )}
    </div>
  )
}

/**
 * Под шапкой объекта (DESIGN §4.4): мета-строка 20 и строка «где залито» 32 по пяти
 * страницам. Нажатие на страницу раскрывает в панели «Где залито · страница».
 */
export function ObjectSummary() {
  const today = useToday()
  const { detail, model, search, openPage } = useObjectPage()
  const promo = usePromoMeta()
  const meta = useMemo(() => {
    const parts = objectMetaParts(detail, today)
    return promo
      ? [...parts.slice(0, 1), ...promo.before, ...parts.slice(1), ...promo.after]
      : parts
  }, [detail, promo, today])
  const summaries = useMemo(() => detail.pages.map((page) => page.summary), [detail.pages])
  const active = model.accounts.find((account) => account.code === search.page)?.label

  return (
    <SummaryLines
      meta={meta}
      type={detail.entry.type}
      summaries={summaries}
      activePage={active}
      onSelectPage={(label) => {
        const account = model.accounts.find((candidate) => candidate.label === label)
        openPage(account?.code === search.page ? undefined : account?.code)
      }}
    />
  )
}

/**
 * Те же строки до ответа сервера (DESIGN §3.13): мета — из записи каталога, «где залито» —
 * из сводки по страницам. Оба индекса уже в памяти браузера, поэтому первый кадр страницы
 * объекта сразу несёт смысл, а не серые полосы.
 */
export function ObjectSummaryPreview({ entry }: { entry: CatalogEntry }) {
  const today = useToday()
  const model = useCurrentModel()
  const summaries = usePageSummaries(model.code).data?.byItem.get(entry.id)
  const meta = useMemo(() => entryMetaParts(entry, today), [entry, today])
  return <SummaryLines meta={meta} type={entry.type} summaries={summaries ?? []} />
}
