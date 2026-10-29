import { formatDate, type LocalDate, type MarkupField, mskDate } from '@contentops/contracts'
import { FieldStatus } from '@contentops/ui/components/field-status'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { type ReactNode, useId, useRef } from 'react'
import { useToday } from '@/data/api-session'
import type { FieldConflict } from './use-field-save'

interface FieldRowProps {
  label: string
  field: MarkupField | undefined
  conflict: FieldConflict | null
  onShowTheirs: () => void
  onKeepMine: () => void
  children: (labelId: string) => ReactNode
}

/** «Диана 12.08» — кто и когда подтвердил поле. */
function confirmedText(field: MarkupField, today: LocalDate): string | undefined {
  if (!field.confirmed_by || !field.confirmed_at) {
    return undefined
  }
  return `${field.confirmed_by} ${formatDate(mskDate(field.confirmed_at), today)}`
}

/**
 * Поле разметки (DESIGN §5.4): подпись 13/18 серым, как у полей всех форм, состояние 12/16
 * справа, ниже значение.
 * Конфликт версии встаёт строкой на месте поля с «Показать её вариант · Оставить мой».
 * После отказа ИИ «разметить вручную» ставит фокус в само поле.
 */
export function FieldRow({
  label,
  field,
  conflict,
  onShowTheirs,
  onKeepMine,
  children,
}: FieldRowProps) {
  const today = useToday()
  const labelId = useId()
  const valueRef = useRef<HTMLDivElement>(null)
  const focusValue = () =>
    valueRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <span id={labelId} className="text-ink-3 text-sm">
          {label}
        </span>
        {field ? (
          <FieldStatus
            status={field.status}
            confirmed={confirmedText(field, today)}
            source={field.source_hint ?? undefined}
            onManual={focusValue}
          />
        ) : null}
      </div>
      {conflict ? (
        <ConflictLine
          message={conflict.message}
          theirsLabel={conflict.theirsLabel}
          onShowTheirs={onShowTheirs}
          onKeepMine={onKeepMine}
        />
      ) : (
        <div ref={valueRef} className="flex flex-col">
          {children(labelId)}
        </div>
      )}
    </div>
  )
}
