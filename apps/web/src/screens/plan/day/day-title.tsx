import {
  type Account,
  formatBytes,
  formatLongDay,
  formatNumber,
  type IntegrationLine,
  type LocalDate,
  type PlanRow,
  type Release,
} from '@contentops/contracts'
import { DownloadButton, type DownloadOption } from '@contentops/ui/components/download-button'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import { usePlanDownload } from '../shared/actions/use-plan-download'

interface DayTitleProps {
  date: LocalDate
  today: LocalDate
  accounts: readonly Account[]
  rows: readonly PlanRow[]
  releases: readonly Release[]
  /** Hub одинаково не работает на всех страницах — одна строка здесь, а не в каждой группе. */
  integration: IntegrationLine | null
  /** Строки, что сейчас в списке (после «Мои» и страниц): чип выпуска считает их. */
  shownRowIds: ReadonlySet<string>
  sizeBytes: number
  /** «Мои»: объём и архив — только свои строки. */
  mine: boolean
  canDownload: boolean
  /** Чип выпуска выделяет его строки (§4.11). */
  onSelectRelease: (release: Release) => void
}

function readyBytes(rows: readonly PlanRow[]): number {
  return rows.reduce((sum, row) => sum + (row.copy?.state === 'ready' ? row.copy.size_bytes : 0), 0)
}

/**
 * Заголовок дня 40 (DESIGN §4.11): «Вторник, 22 сентября», в день выпуска — чип
 * «Выпуск PPV-076 · 14 · выделить», справа «Скачать всё за день ▾ · 3,2 ГБ» (в ▾ — по
 * страницам с объёмом и «Стереть метаданные»).
 */
export function DayTitle({
  date,
  today,
  accounts,
  rows,
  releases,
  integration,
  shownRowIds,
  sizeBytes,
  mine,
  canDownload,
  onSelectRelease,
}: DayTitleProps) {
  const zip = usePlanDownload()
  const options: DownloadOption[] = [
    { id: 'all', label: 'Всё за день', hint: formatBytes(sizeBytes) },
    ...accounts.flatMap((account) => {
      const pageRows = rows.filter((row) => row.account === account.code && row.manifest)
      return pageRows.length > 0
        ? [{ id: account.code, label: account.label, hint: formatBytes(readyBytes(pageRows)) }]
        : []
    }),
  ]
  const download = (id: string, stripMetadata: boolean) =>
    zip.download({ scope: 'day', date }, id === 'all' ? null : id, stripMetadata, mine)

  return (
    <div className="@container/day-title flex h-10 shrink-0 items-center gap-3 whitespace-nowrap">
      <h2 className="shrink-0 text-lg">{formatLongDay(date)}</h2>
      {date === today ? (
        <span className="text-ink-3 text-sm @max-[46rem]/day-title:hidden">сегодня</span>
      ) : null}
      {releases.map((release) => {
        const total = release.row_ids.length
        const shown = release.row_ids.filter((id) => shownRowIds.has(id)).length
        // При «Мои» видна часть выпуска — так и пишем: «9 из 14», выделяются видимые.
        const count =
          shown < total ? `${formatNumber(shown)} из ${formatNumber(total)}` : formatNumber(total)
        return (
          <button
            key={release.id}
            type="button"
            disabled={shown === 0}
            onClick={() => onSelectRelease(release)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-3xl bg-secondary px-3 text-sm transition-colors duration-120 enabled:hover:bg-secondary-hover disabled:text-muted-foreground"
          >
            Выпуск {release.item_id} · {count}
            {shown > 0 ? (
              <>
                {' '}
                · <span className="text-primary-ink">выделить</span>
              </>
            ) : null}
          </button>
        )
      })}
      {integration ? (
        <IntegrationPhrase line={integration} withOwnerAction className="min-w-0" />
      ) : null}
      {canDownload && options.length > 1 ? (
        <div className="ml-auto flex items-center gap-2">
          <DownloadButton
            label="Скачать всё за день"
            size="sm"
            options={options}
            onDownload={download}
          />
          <span className="text-ink-3 text-sm tabular-nums @max-[46rem]/day-title:hidden">
            {formatBytes(sizeBytes)}
          </span>
        </div>
      ) : null}
    </div>
  )
}
