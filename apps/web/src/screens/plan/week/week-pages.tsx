import {
  type Account,
  type AccountCode,
  formatNumber,
  type LocalDate,
  type PlanWeek,
} from '@contentops/contracts'
import { SectionTabs } from '@contentops/ui/components/section-tabs'
import { cn } from '@contentops/ui/lib/utils'
import { WeekCell } from './week-cell'
import { type GridHandlers, moveWeekFocus } from './week-grid'
import { DayLabel } from './week-heads'
import { cellItems } from './week-layout'

interface WeekPagesProps {
  week: PlanWeek
  accounts: readonly Account[]
  page: Account
  onPageChange: (page: AccountCode) => void
  today: LocalDate
  selectedKeys: ReadonlySet<string>
  canAct: boolean
  handlers: GridHandlers
}

/**
 * Второй вид недели для сравнения (DESIGN §4.12, `?variant=pages`): одна страница за раз —
 * вкладки «Fansly 1 · Fansly 2 · пусто 7 · …», семь столбцов дней, миниатюры 64.
 */
export function WeekPages({
  week,
  accounts,
  page,
  onPageChange,
  today,
  selectedKeys,
  canAct,
  handlers,
}: WeekPagesProps) {
  return (
    <div className="flex flex-col gap-3">
      <SectionTabs
        label="Страница"
        value={page.code}
        onChange={onPageChange}
        tabs={accounts.map((account) => {
          const column = week.columns.find((candidate) => candidate.account === account.code)
          const empty = column && column.empty > 0 ? `пусто ${formatNumber(column.empty)}` : ''
          const missed =
            column && column.missed > 0 ? `пропущено ${formatNumber(column.missed)}` : ''
          return {
            value: account.code,
            label: account.label,
            detail: empty || undefined,
            alert: missed ? (empty ? `· ${missed}` : missed) : undefined,
          }
        })}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: стрелки ходят между днями, сами дни — кнопки строк */}
      <div onKeyDown={moveWeekFocus} className="grid grid-cols-7 border-border border-t">
        {week.dates.map((date, day) => (
          <div
            key={date}
            className={cn(
              'flex min-w-0 flex-col border-border border-r last:border-r-0',
              date === today && 'bg-primary-tint/40',
            )}
          >
            <DayLabel
              className="h-auto px-1"
              date={date}
              today={today}
              canAct={canAct}
              onSelectDay={() =>
                handlers.selectRows(
                  week.rows
                    .filter((row) => row.date === date && row.account === page.code)
                    .map((row) => row.id),
                )
              }
            />
            <WeekCell
              date={date}
              account={page.code}
              items={cellItems(week, date, page.code)}
              selectedKeys={selectedKeys}
              past={date < today}
              large
              canAct={canAct}
              position={{ day: 0, page: day }}
              handlers={handlers}
              className="min-h-40"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
