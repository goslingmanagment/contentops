import { addDays, formatShortDay, type LocalDate, type LocalTime } from '@contentops/contracts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { TimeField } from '../shared/time-field'

/** Четыре недели: выпуск раз в 2 недели по норме встаёт дальше двух недель вперёд. */
const DAYS_AHEAD = 28

interface SlotControlsProps {
  date: LocalDate
  time: LocalTime | null
  today: LocalDate
  onDateChange: (date: LocalDate) => void
  onTimeChange: (time: LocalTime | null) => void
  /** «стена», «рассылка» — для подписей полей с клавиатуры. */
  label: string
}

/** День и время столбца выпуска: «чт 24 ▾» и «20:00», компактно, в шапке столбца. */
export function SlotControls({
  date,
  time,
  today,
  onDateChange,
  onTimeChange,
  label,
}: SlotControlsProps) {
  const days = Array.from({ length: DAYS_AHEAD }, (_, index) => addDays(today, index))
  return (
    <div className="flex flex-col gap-1">
      <Select
        value={date}
        onValueChange={(next) => {
          const day = days.find((candidate) => candidate === next)
          if (day) {
            onDateChange(day)
          }
        }}
      >
        <SelectTrigger size="sm" aria-label={`День: ${label}`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {days.map((day) => (
            <SelectItem key={day} value={day}>
              {formatShortDay(day)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <TimeField value={time} label={`Время: ${label}`} onChange={onTimeChange} compact />
    </div>
  )
}
