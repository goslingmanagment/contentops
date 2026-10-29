import {
  addDays,
  capitalize,
  type DayDot,
  formatWeekdayShort,
  isoWeekOf,
  type LocalDate,
  weekDates,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { Link } from '@tanstack/react-router'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import type { PlanDaySearch } from '../search'

interface DateStripProps {
  model: string
  date: LocalDate
  today: LocalDate
  /** Точка у даты — только если в дне есть ▲ или ◆ (§4.11). */
  dots: readonly DayDot[]
  search: PlanDaySearch
}

const DOT_CLASS = { trouble: 'bg-destructive', turn: 'bg-attention', done: 'hidden' } as const

/**
 * Ряд дат 40 (DESIGN §4.11): «‹ ›» листают по дню, семь дат недели, «Сегодня». Сегодня —
 * синее число, выбранный день — фон `--primary-tint`.
 */
export function DateStrip({ model, date, today, dots, search }: DateStripProps) {
  const days = weekDates(isoWeekOf(date))
  const linkProps = (target: LocalDate) => ({
    to: '/$model/plan/$date' as const,
    params: { model, date: target },
    search,
  })
  return (
    <nav aria-label="Дни недели" className="flex h-10 shrink-0 items-center gap-1">
      <Button variant="ghost" size="icon-sm" asChild>
        <Link {...linkProps(addDays(date, -1))} aria-label="Предыдущий день">
          <ChevronLeftIcon />
        </Link>
      </Button>
      <ol className="flex items-center gap-1">
        {days.map((day) => {
          const sign = dots.find((dot) => dot.date === day)?.sign ?? null
          return (
            <li key={day}>
              <Link
                {...linkProps(day)}
                aria-current={day === date ? 'date' : undefined}
                data-selected={day === date}
                className="relative flex h-9 w-16 items-center justify-center gap-1 rounded-lg text-base transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint data-[selected=true]:text-primary-ink"
              >
                <span className="text-muted-foreground">{capitalize(formatWeekdayShort(day))}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    day === today ? 'font-semibold text-primary' : 'font-medium',
                  )}
                >
                  {Number(day.slice(8, 10))}
                </span>
                {sign ? (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        'absolute top-1.5 right-2 size-1.5 rounded-full',
                        DOT_CLASS[sign],
                      )}
                    />
                    <span className="sr-only">
                      {sign === 'trouble' ? ', есть беда' : ', есть твой ход'}
                    </span>
                  </>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ol>
      <Button variant="ghost" size="icon-sm" asChild>
        <Link {...linkProps(addDays(date, 1))} aria-label="Следующий день">
          <ChevronRightIcon />
        </Link>
      </Button>
      <Button variant="secondary" size="sm" className="ml-2" asChild>
        <Link {...linkProps(today)}>Сегодня</Link>
      </Button>
    </nav>
  )
}
