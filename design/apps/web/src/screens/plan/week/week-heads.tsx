import {
  type Account,
  capitalize,
  formatNumber,
  formatWeekdayShort,
  type IntegrationLine as IntegrationLineData,
  type LocalDate,
  type WeekColumn,
} from '@contentops/contracts'
import {
  IntegrationLine,
  type IntegrationState as IntegrationLineState,
} from '@contentops/ui/components/integration-line'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { cn } from '@contentops/ui/lib/utils'
import { useDroppable } from '@dnd-kit/core'
import { integrationShort } from '../shared/plan-text'
import type { WeekDropData } from './week-dnd'

interface ColumnHeadProps {
  account: Account
  column: WeekColumn | undefined
  /** Клик по шапке столбца выделяет его строки (§3.3). */
  onSelectColumn: () => void
  /** Прошедшая неделя: «пусто 1» — серое число, поставить туда уже нельзя. */
  past: boolean
  /** «пусто 7» → ящик «Ещё не залито» по этой странице. */
  onOpenEmpty: () => void
  /** «пропущено 1» → выделить пропущенные строки. */
  onSelectMissed: () => void
}

/**
 * Шапка столбца 56 (DESIGN §4.12): «Fansly 2 · LoraViex», под ней «пусто 7» серой
 * ссылкой и «пропущено 1» красным. Норма — в подсказке при наведении. Если Hub страницы
 * не работает, ниже его строка (§3.11).
 */
export function ColumnHead({
  account,
  column,
  past,
  onSelectColumn,
  onOpenEmpty,
  onSelectMissed,
}: ColumnHeadProps) {
  return (
    <div className="flex min-h-14 min-w-0 flex-col justify-center gap-0.5 px-2.5 py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onSelectColumn}
            className="flex min-w-0 items-baseline gap-1.5 rounded-sm text-left outline-none hover:text-primary-ink focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="shrink-0 font-medium text-base">{account.label}</span>
            <span className="truncate text-ink-3 text-sm">{account.handle}</span>
          </button>
        </TooltipTrigger>
        {column?.norm_hint ? (
          <TooltipContent side="bottom" className="max-w-80">
            {column.norm_hint}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <div className="flex min-h-4 items-center gap-3 whitespace-nowrap text-sm">
        {column && column.empty > 0 && past ? (
          <span className="text-ink-3 tabular-nums">пусто {formatNumber(column.empty)}</span>
        ) : null}
        {column && column.empty > 0 && !past ? (
          <button
            type="button"
            onClick={onOpenEmpty}
            className="rounded-sm text-muted-foreground tabular-nums underline-offset-4 outline-none hover:text-primary-ink hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            пусто {formatNumber(column.empty)}
          </button>
        ) : null}
        {column && column.missed > 0 ? (
          <button
            type="button"
            onClick={onSelectMissed}
            className="rounded-sm text-destructive tabular-nums underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            пропущено {formatNumber(column.missed)}
          </button>
        ) : null}
      </div>
      {column?.integration ? <ColumnHub line={column.integration} /> : null}
    </div>
  )
}

const LINE_STATE: Record<IntegrationLineData['state'], IntegrationLineState> = {
  working: 'ok',
  off: 'off',
  unset: 'unset',
  down: 'down',
  catching_up: 'catching-up',
}

/**
 * Hub страницы в шапке столбца (§3.11): значок и короткая фраза «Hub недоступен с 13:52»,
 * полная — в подсказке.
 */
function ColumnHub({ line }: { line: IntegrationLineData }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0">
          <IntegrationLine
            state={LINE_STATE[line.state]}
            tabIndex={0}
            aria-label={line.text}
            className="min-w-0 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {integrationShort(line.text)}
          </IntegrationLine>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80">
        {line.text}
      </TooltipContent>
    </Tooltip>
  )
}

interface DayLabelProps {
  /** Во втором виде недели подпись стоит над столбцом и не тянется в высоту. */
  className?: string
  date: LocalDate
  today: LocalDate
  canAct: boolean
  /** Клик по подписи дня выделяет его строки. */
  onSelectDay: () => void
}

/**
 * Подпись дня «22 Вт» (сегодня — синим). На неё можно отпустить плитку из ящика — окно
 * «В план» со страницами по норме.
 */
export function DayLabel({ date, today, canAct, onSelectDay, className }: DayLabelProps) {
  const data: WeekDropData = { kind: 'day', date }
  const drop = useDroppable({ id: `day:${date}`, data, disabled: !canAct || date < today })
  return (
    <div ref={drop.setNodeRef} className={cn('h-full py-1 pr-1', className)}>
      <button
        type="button"
        onClick={onSelectDay}
        className={cn(
          'flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left outline-none transition-colors duration-120 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          drop.isOver && 'bg-primary-tint ring-2 ring-primary/40',
          date < today && 'text-muted-foreground',
        )}
      >
        <span
          className={cn(
            'text-lg tabular-nums leading-6',
            date === today && 'font-semibold text-primary',
          )}
        >
          {Number(date.slice(8, 10))}
        </span>
        <span className={cn('text-sm', date === today ? 'text-primary' : 'text-ink-3')}>
          {capitalize(formatWeekdayShort(date))}
        </span>
      </button>
    </div>
  )
}
