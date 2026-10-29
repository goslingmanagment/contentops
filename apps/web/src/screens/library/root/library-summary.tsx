import { formatNumber, type IntegrationLine, type Model, plural } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useHref } from '@/app/use-href'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import { ITEM_TYPE_ICON } from '@/shell/navigation/icons'
import { useLibraryLinks } from '../shared/library-hrefs'
import type { PageNotUploaded } from '../shared/not-uploaded-index'
import { isTypeFolder, type LibraryFolder } from './library-folders'

interface LibrarySummaryProps {
  model: Model
  total: number
  folders: readonly LibraryFolder[]
  notUploaded: readonly PageNotUploaded[] | null
  hubLine: IntegrationLine | null
}

const rowClass =
  'flex h-9 items-center gap-3 rounded-lg px-2 text-base transition-colors duration-120 hover:bg-accent'

/**
 * Панель корня без выделения: что есть у модели по разделам и что ещё не залито по
 * страницам. Каждое число ведёт туда, где по нему действуют.
 */
export function LibrarySummary({
  model,
  total,
  folders,
  notUploaded,
  hubLine,
}: LibrarySummaryProps) {
  const links = useLibraryLinks()
  const href = useHref()
  return (
    <>
      <InfoSection
        title={model.name}
        aside={
          <span className="text-ink-3 tabular-nums">
            {formatNumber(total)} {plural(total, ['объект', 'объекта', 'объектов'])}
          </span>
        }
      >
        <ul className="-mx-2 flex flex-col">
          {folders.filter(isTypeFolder).map((folder) => {
            const Icon = ITEM_TYPE_ICON[folder.key]
            return (
              <li key={folder.key}>
                <UiLink href={links.folder(folder.key)} className={rowClass}>
                  <Icon aria-hidden className="size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  {folder.note?.kind === 'week' ? (
                    <span className="text-ink-3 text-sm tabular-nums">
                      +{formatNumber(folder.note.count)}
                    </span>
                  ) : null}
                  <span className="w-12 text-right tabular-nums">
                    {formatNumber(folder.count ?? 0)}
                  </span>
                </UiLink>
              </li>
            )
          })}
        </ul>
      </InfoSection>
      <InfoSection title="Ещё не залито" aside={<span className="text-ink-3">без фупов</span>}>
        {hubLine ? <IntegrationPhrase line={hubLine} wrap withOwnerAction /> : null}
        {notUploaded ? (
          <ul className="-mx-2 flex flex-col">
            {notUploaded.map(({ account, items }) => (
              <li key={account.code}>
                <UiLink
                  href={href({
                    to: '/$model/library/not-uploaded',
                    params: { model: model.code },
                    search: { page: account.code },
                  })}
                  className={rowClass}
                >
                  <span className="min-w-0 flex-1 truncate">{account.label}</span>
                  <span className="w-12 text-right tabular-nums">{formatNumber(items.length)}</span>
                </UiLink>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Считается…</p>
        )}
      </InfoSection>
    </>
  )
}
