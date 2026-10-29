import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import { cn } from '@contentops/ui/lib/utils'
import { XIcon } from 'lucide-react'
import { useState } from 'react'

export interface TimeFieldProps {
  value: string | null
  label: string
  onChange: (time: string | null) => void
  /** Узкое место (шапка столбца выпуска): поле во всю ширину, без «×». */
  compact?: boolean
  className?: string
}

/**
 * Время места: пустое поле подписано «любое время», а не системным «--:--» (§4.13–4.14).
 * Нажатие открывает ввод времени, «×» снова делает время любым.
 */
export function TimeField({ value, label, onChange, compact = false, className }: TimeFieldProps) {
  const [editing, setEditing] = useState(false)
  if (value === null && !editing) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`${label}: любое время`}
        onClick={() => setEditing(true)}
        className={cn(
          'h-8 justify-start overflow-hidden font-normal text-ink-3',
          compact ? 'w-full px-1.5 text-xs' : 'w-24 px-2 text-sm',
          className,
        )}
      >
        любое время
      </Button>
    )
  }
  return (
    <span className={cn('inline-flex items-center gap-0.5', compact && 'w-full', className)}>
      <Input
        type="time"
        value={value ?? ''}
        autoFocus={editing && value === null}
        onChange={(event) => onChange(event.target.value || null)}
        onBlur={() => setEditing(false)}
        aria-label={label}
        className={cn(
          'h-8 px-2 text-sm tabular-nums [&::-webkit-calendar-picker-indicator]:hidden',
          compact ? 'w-full' : 'w-20',
        )}
      />
      {value !== null && !compact ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${label}: сделать любым`}
          onClick={() => onChange(null)}
          className="size-6"
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </span>
  )
}
