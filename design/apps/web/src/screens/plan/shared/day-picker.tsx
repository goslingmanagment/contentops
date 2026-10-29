import { addDays, daysBetween, formatWeekdayShort, type LocalDate } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ToggleGroup, ToggleGroupItem } from '@contentops/ui/components/toggle-group'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'

interface DayPickerProps {
  value: LocalDate
  onChange: (date: LocalDate) => void
  today: LocalDate
  /** Дни с пустыми местами нормы: метка под числом (§4.13). */
  marked?: ReadonlySet<LocalDate>
  label: string
}

const WEEK = 7

/**
 * «День» — семь дней одной кнопкой (DESIGN §4.13): с сегодняшнего, стрелки листают на
 * неделю вперёд. Прошедшие дни не выбираются, у дней с пустыми местами — точка.
 */
export function DayPicker({ value, onChange, today, marked, label }: DayPickerProps) {
  const [offset, setOffset] = useState(() =>
    Math.max(0, Math.floor(daysBetween(today, value) / WEEK)),
  )
  const start = addDays(today, offset * WEEK)
  const days = Array.from({ length: WEEK }, (_, index) => addDays(start, index))
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Раньше"
        disabled={offset === 0}
        onClick={() => setOffset((current) => Math.max(0, current - 1))}
      >
        <ChevronLeftIcon />
      </Button>
      <ToggleGroup
        type="single"
        variant="segment"
        aria-label={label}
        value={value}
        onValueChange={(next) => {
          const day = days.find((candidate) => candidate === next)
          if (day) {
            onChange(day)
          }
        }}
      >
        {days.map((day) => (
          <ToggleGroupItem key={day} value={day} className="relative h-11 w-12 flex-col gap-0 px-0">
            <span className="text-ink-3 text-xs">{formatWeekdayShort(day)}</span>
            <span className={cn('text-base tabular-nums', day === today && 'text-primary')}>
              {Number(day.slice(8, 10))}
            </span>
            {marked?.has(day) ? (
              <span aria-hidden className="absolute bottom-1 size-1 rounded-full bg-ink-3" />
            ) : null}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Позже"
        onClick={() => setOffset((current) => current + 1)}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  )
}
