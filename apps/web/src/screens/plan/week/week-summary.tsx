import { type Account, formatNumber, type PlanWeek } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { StatusWord } from '@contentops/ui/components/status-word'
import { isDoneRow, rowsWord } from '../shared/plan-text'

interface WeekSummaryProps {
  week: PlanWeek
  accounts: readonly Account[]
}

/**
 * Панель недели без выделения — недельная сводка темпа (DESIGN §4.12): по странице
 * сколько сделано, сколько мест нормы пусто и сколько пропущено.
 */
export function WeekSummary({ week, accounts }: WeekSummaryProps) {
  return (
    <InfoSection title={`${rowsWord(week.rows.length)} на неделе`}>
      <ul className="flex flex-col">
        {accounts.map((account) => {
          const rows = week.rows.filter((row) => row.account === account.code)
          const column = week.columns.find((candidate) => candidate.account === account.code)
          return (
            <li key={account.code} className="flex min-h-9 items-center gap-3 py-1">
              <span className="w-20 shrink-0 text-base">{account.label}</span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 text-sm">
                <span className="text-muted-foreground tabular-nums">
                  сделано {formatNumber(rows.filter(isDoneRow).length)} из{' '}
                  {formatNumber(rows.length)}
                </span>
                {column && column.empty > 0 ? (
                  <span className="text-ink-3">пусто {formatNumber(column.empty)}</span>
                ) : null}
                {column && column.missed > 0 ? (
                  <StatusWord sign="trouble">пропущено {formatNumber(column.missed)}</StatusWord>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
    </InfoSection>
  )
}
