import {
  type AccountCode,
  type CatalogEntry,
  formatNumber,
  type Model,
  notUploadedStatus,
} from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useMemo } from 'react'
import { useHref } from '@/app/use-href'
import { type PageSummariesView, pageSummaryOf } from '@/data/catalog'
import { folderComposition } from '../root/folder-composition'
import type { SectionType } from './section-config'

interface SectionSummaryProps {
  model: Model
  type: SectionType
  title: string
  entries: readonly CatalogEntry[]
  summaries: PageSummariesView | undefined
}

const rowClass =
  'flex h-9 items-center gap-3 rounded-lg px-2 text-base transition-colors duration-120 hover:bg-accent'

/** Сколько объектов раздела ещё не залито на каждую страницу — тем же правилом, что у сервера. */
function notUploadedCounts(
  model: Model,
  entries: readonly CatalogEntry[],
  summaries: PageSummariesView,
): { account: AccountCode; label: string; count: number }[] {
  return model.accounts.flatMap((account) => {
    const statuses = entries.map((entry) =>
      notUploadedStatus(entry, pageSummaryOf(summaries, entry.id, account.code), account.platform),
    )
    if (statuses.every((status) => status === 'not_applicable')) {
      return []
    }
    const count = statuses.filter((status) => status === 'not_uploaded').length
    return [{ account: account.code, label: account.label, count }]
  })
}

/**
 * Панель раздела без выделения (DESIGN §3.4): что в разделе одной строкой и что ещё не
 * залито по страницам — каждое число ведёт туда, где по нему действуют.
 */
export function SectionSummary({ model, type, title, entries, summaries }: SectionSummaryProps) {
  const href = useHref()
  const pages = useMemo(
    () => (summaries ? notUploadedCounts(model, entries, summaries) : null),
    [model, entries, summaries],
  )
  return (
    <>
      <InfoSection
        title={title}
        aside={<span className="text-ink-3 tabular-nums">{formatNumber(entries.length)}</span>}
      >
        <p>{folderComposition(type, entries)}</p>
      </InfoSection>
      {pages && pages.length > 0 ? (
        <InfoSection title="Ещё не залито">
          <ul className="-mx-2 flex flex-col">
            {pages.map((page) => (
              <li key={page.account}>
                <UiLink
                  href={href({
                    to: '/$model/library/not-uploaded',
                    params: { model: model.code },
                    search: { page: page.account },
                  })}
                  className={rowClass}
                >
                  <span className="min-w-0 flex-1 truncate">{page.label}</span>
                  <span className="w-12 text-right tabular-nums">{formatNumber(page.count)}</span>
                </UiLink>
              </li>
            ))}
          </ul>
        </InfoSection>
      ) : null}
    </>
  )
}
