import {
  type Account,
  type CatalogEntry,
  daysBetween,
  formatDate,
  formatDaysAgo,
  type LocalDate,
  type PageSummaryEntry,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Thumb } from '@contentops/ui/components/thumb'
import { itemCover } from '@/lib/item-cover'
import { metaLine } from '@/objects/item-facts'

interface ObjectCardProps {
  entry: CatalogEntry
  /** «Выбрать другой» — только если объект выбирали поиском в самом окне. */
  onChange?: () => void
}

/** Левая колонка окна (DESIGN §4.13): обложка 3:4 × 200, ID, название, тип, длительность. */
export function ObjectCard({ entry, onChange }: ObjectCardProps) {
  return (
    <div className="flex flex-col gap-3">
      <Thumb {...itemCover(entry)} className="w-37.5 rounded-xl" />
      <div className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-sm tabular-nums">{entry.id}</span>
        <h3 className="line-clamp-2 text-lg">{entry.title}</h3>
        <span className="text-muted-foreground text-sm">{metaLine(entry)}</span>
      </div>
      {onChange ? (
        <Button variant="link" size="inline" className="self-start text-sm" onClick={onChange}>
          Выбрать другой
        </Button>
      ) : null}
    </div>
  )
}

interface WherePlacedProps {
  accounts: readonly Account[]
  summaries: readonly PageSummaryEntry[]
  today: LocalDate
}

/** «12.08 · 41 день назад», другой год — «22.09.2025 · год назад». Дни — от сегодня. */
export function placedText(summary: PageSummaryEntry | undefined, today: LocalDate): string {
  if (!summary?.last_on) {
    return summary?.detail ?? summary?.word ?? 'не видели'
  }
  const days = daysBetween(summary.last_on, today)
  return `${formatDate(summary.last_on, today)} · ${formatDaysAgo(days)}`
}

/**
 * «Где уже залито» (§4.13): по странице дата и сколько дней назад или «не видели»; серая
 * подпись старого имени — из сводки страницы.
 */
export function WherePlaced({ accounts, summaries, today }: WherePlacedProps) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {accounts.map((account) => {
        const summary = summaries.find((candidate) => candidate.account === account.code)
        return (
          <li key={account.code} className="flex gap-2">
            <span className="w-14 shrink-0 text-muted-foreground">{account.label}</span>
            {/* Переносится, а не обрезается: «15.03.2025 · полтора года назад» — весь ответ. */}
            <span className="min-w-0">{placedText(summary, today)}</span>
          </li>
        )
      })}
    </ul>
  )
}
