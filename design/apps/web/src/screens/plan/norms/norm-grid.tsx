import { NORM_KIND_LABEL, type NormKind, type UpdateWeekNormCommand } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { MinusIcon, PlusIcon } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { TimeField } from '../shared/time-field'
import { WEEKDAYS } from './norm-text'

const MAX_PER_DAY = 9

interface NormGridProps {
  cells: UpdateWeekNormCommand['cells']
  /** Строки, которых у страницы нет (фуп у OnlyFans): не рисуются, номера строк те же. */
  hidden?: ReadonlySet<NormKind>
  readOnly: boolean
  onCountChange: (row: number, day: number, count: number) => void
  onTimeChange: (row: number, time: string | null) => void
}

const MOVES: Record<string, [number, number] | undefined> = {
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
}

/**
 * Сетка «тип × день» (DESIGN §4.14): в ячейке счётчик `−` / число / `+`, справа время.
 * Стрелки ходят по ячейкам, `+` и `−` меняют число.
 */
export function NormGrid({
  cells,
  hidden = new Set(),
  readOnly,
  onCountChange,
  onTimeChange,
}: NormGridProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const row = Number(target?.dataset.row)
    const day = Number(target?.dataset.day)
    if (!target || Number.isNaN(row) || Number.isNaN(day)) {
      return
    }
    const move = MOVES[event.key]
    if (move) {
      // Скрытые строки пропускаются: ищем следующую нарисованную в ту же сторону.
      for (let step = 1; step <= cells.length; step++) {
        const next = event.currentTarget.querySelector<HTMLElement>(
          `[data-row="${row + move[0] * step}"][data-day="${day + move[1] * step}"]`,
        )
        if (next) {
          event.preventDefault()
          next.focus()
          break
        }
        if (move[0] === 0) {
          break
        }
      }
      return
    }
    const count = cells[row]?.per_day[day] ?? 0
    if (!readOnly && (event.key === '+' || event.key === '=')) {
      event.preventDefault()
      onCountChange(row, day, Math.min(MAX_PER_DAY, count + 1))
    }
    if (!readOnly && (event.key === '-' || event.key === '_')) {
      event.preventDefault()
      onCountChange(row, day, Math.max(0, count - 1))
    }
  }

  return (
    <table onKeyDown={onKeyDown} className="w-full table-fixed border-separate border-spacing-0">
      <thead>
        <tr className="h-10 text-ink-3 text-sm">
          <th scope="col" className="w-52 text-left font-normal">
            Тип
          </th>
          {WEEKDAYS.map((day) => (
            <th key={day} scope="col" className="text-center font-normal">
              {day}
            </th>
          ))}
          <th scope="col" className="w-28 pl-3 text-left font-normal">
            Время
          </th>
        </tr>
      </thead>
      <tbody>
        {cells.map((cell, row) =>
          hidden.has(cell.kind) ? null : (
            <tr key={cell.kind} className="h-13">
              <th scope="row" className="border-border border-t text-left font-normal text-base">
                {NORM_KIND_LABEL[cell.kind]}
              </th>
              {cell.per_day.map((count, day) => (
                <td key={day} className="border-border border-t text-center">
                  <Counter
                    row={row}
                    day={day}
                    count={count}
                    label={`${NORM_KIND_LABEL[cell.kind]}, ${WEEKDAYS[day]}`}
                    readOnly={readOnly}
                    onChange={(next) => onCountChange(row, day, next)}
                  />
                </td>
              ))}
              <td className="border-border border-t pl-3">
                {readOnly || !cell.per_day.some((count) => count > 0) ? (
                  <span
                    className={cn('tabular-nums', cell.time ? 'text-base' : 'text-ink-3 text-sm')}
                  >
                    {cell.time ?? (cell.per_day.some((count) => count > 0) ? 'любое время' : '—')}
                  </span>
                ) : (
                  <TimeField
                    value={cell.time}
                    label={`Время: ${NORM_KIND_LABEL[cell.kind]}`}
                    onChange={(time) => onTimeChange(row, time)}
                  />
                )}
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  )
}

interface CounterProps {
  row: number
  day: number
  count: number
  label: string
  readOnly: boolean
  onChange: (count: number) => void
}

/** Число в ячейке, по бокам `−` и `+`; они видны при наведении и фокусе, чтобы сетка была тихой. */
function Counter({ row, day, count, label, readOnly, onChange }: CounterProps) {
  return (
    <div className="group/counter inline-flex items-center gap-0.5">
      {readOnly ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          tabIndex={-1}
          aria-label={`Меньше: ${label}`}
          disabled={count === 0}
          onClick={() => onChange(count - 1)}
          className="size-6 opacity-0 transition-opacity duration-120 group-focus-within/counter:opacity-100 group-hover/counter:opacity-100 disabled:opacity-0"
        >
          <MinusIcon className="size-3.5" />
        </Button>
      )}
      <span
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuenow={count}
        aria-valuemin={0}
        aria-valuemax={MAX_PER_DAY}
        aria-readonly={readOnly}
        data-row={row}
        data-day={day}
        className={cn(
          'inline-flex h-8 w-7 items-center justify-center rounded-md text-base tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
          count === 0 && 'text-ink-3',
        )}
      >
        {count === 0 ? '—' : count}
      </span>
      {readOnly ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          tabIndex={-1}
          aria-label={`Больше: ${label}`}
          disabled={count >= MAX_PER_DAY}
          onClick={() => onChange(count + 1)}
          className="size-6 opacity-0 transition-opacity duration-120 group-focus-within/counter:opacity-100 group-hover/counter:opacity-100 disabled:opacity-0"
        >
          <PlusIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
