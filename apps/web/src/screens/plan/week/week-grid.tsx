import type { Account, AccountCode, LocalDate, PlanWeek } from '@contentops/contracts'
import { cn } from '@contentops/ui/lib/utils'
import type { CSSProperties, KeyboardEvent } from 'react'
import { type CellHandlers, WeekCell } from './week-cell'
import { ColumnHead, DayLabel } from './week-heads'
import { cellItems } from './week-layout'

export interface GridHandlers extends CellHandlers {
  selectRows: (rowIds: readonly string[]) => void
  openEmpty: (account: AccountCode) => void
}

interface WeekGridProps {
  week: PlanWeek
  accounts: readonly Account[]
  today: LocalDate
  selectedKeys: ReadonlySet<string>
  canAct: boolean
  handlers: GridHandlers
}

const STEP: Record<string, [number, number] | undefined> = {
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
}

/** Стрелки по ячейкам (§4.12): фокус встаёт на первую строку или место нормы ячейки. */
export function moveWeekFocus(event: KeyboardEvent<HTMLDivElement>) {
  const step = STEP[event.key]
  const cell = event.target instanceof Element ? event.target.closest('[data-week-cell]') : null
  if (!step || !(cell instanceof HTMLElement)) {
    return
  }
  const day = Number(cell.dataset.day) + step[0]
  const page = Number(cell.dataset.page) + step[1]
  const target = event.currentTarget.querySelector<HTMLElement>(
    `[data-week-cell][data-day="${day}"][data-page="${page}"]`,
  )
  if (!target) {
    return
  }
  event.preventDefault()
  const next = target.querySelector<HTMLElement>('button:not(:disabled)') ?? target
  next.focus()
}

/**
 * Таблица постинга недели (DESIGN §4.12): слева столбец дней 64, дальше страницы
 * резиновыми столбцами. Шапка столбцов стоит на месте при прокрутке.
 */
export function WeekGrid({ week, accounts, today, selectedKeys, canAct, handlers }: WeekGridProps) {
  const style = { '--pages': accounts.length } as CSSProperties
  const rowsOf = (predicate: (row: PlanWeek['rows'][number]) => boolean) =>
    week.rows.filter(predicate).map((row) => row.id)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: стрелки ходят между ячейками, сами ячейки — кнопки строк
    <div
      style={style}
      onKeyDown={moveWeekFocus}
      className="grid grid-cols-[4rem_repeat(var(--pages),minmax(0,1fr))]"
    >
      <div className="sticky top-0 z-10 bg-background" />
      {accounts.map((account) => (
        <div key={account.code} className="sticky top-0 z-10 border-border border-b bg-background">
          <ColumnHead
            account={account}
            column={week.columns.find((column) => column.account === account.code)}
            past={(week.dates.at(-1) ?? today) < today}
            onSelectColumn={() =>
              handlers.selectRows(rowsOf((row) => row.account === account.code))
            }
            onOpenEmpty={() => handlers.openEmpty(account.code)}
            onSelectMissed={() =>
              handlers.selectRows(
                rowsOf((row) => row.account === account.code && row.verdict.level === 'missed'),
              )
            }
          />
        </div>
      ))}
      {week.dates.map((date, day) => {
        const past = date < today
        return (
          <div key={date} className="contents">
            <div className={cn('border-border border-b', date === today && 'bg-primary-tint/40')}>
              <DayLabel
                date={date}
                today={today}
                canAct={canAct}
                onSelectDay={() => handlers.selectRows(rowsOf((row) => row.date === date))}
              />
            </div>
            {accounts.map((account, page) => (
              <div
                key={account.code}
                className={cn(
                  'min-w-0 border-border border-b border-l',
                  date === today && 'bg-primary-tint/40',
                )}
              >
                <WeekCell
                  date={date}
                  account={account.code}
                  items={cellItems(week, date, account.code)}
                  selectedKeys={selectedKeys}
                  past={past}
                  canAct={canAct}
                  position={{ day, page }}
                  handlers={handlers}
                />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
