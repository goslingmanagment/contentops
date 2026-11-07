import { formatDate, type LocalDate, type MarkupField, mskDate } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FieldStatus } from '@contentops/ui/components/field-status'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { type ReactNode, useId, useRef } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useApi, useToday } from '@/data/api-session'
import { useItemCommand } from '../../actions/use-item-command'
import { useObjectPage } from '../../object-context'
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

/** Черновики, которые подтверждаются без правки: от ИИ и из импорта (DESIGN §4.4). */
const CONFIRMABLE = new Set(['draft_ai', 'draft_import'])

/**
 * «Подтвердить» одного поля без правки: на месте состояния при наведении на поле и при фокусе
 * с клавиатуры. Подтверждается ровно та версия, что на экране; пришедшее позже остаётся
 * черновиком.
 */
function ConfirmField({ field, status }: { field: MarkupField; status: ReactNode }) {
  const { detail, model } = useObjectPage()
  const api = useApi()
  const toast = useActionToast()
  const confirm = useItemCommand<{ key: MarkupField['field']['key']; version: number }>({
    failed: 'Поле не подтвердилось',
    run: (seen, idempotencyKey) =>
      api.objects.confirmMarkup({
        params: { model: model.code, id: detail.entry.id },
        body: { fields: [seen] },
        idempotencyKey,
      }),
    onSaved: () => toast.show({ message: 'Поле подтверждено' }),
  })
  return (
    <span className="grid min-w-0 justify-items-end [&>*]:col-start-1 [&>*]:row-start-1">
      <span className="transition-opacity duration-120 group-focus-within/field:opacity-0 group-hover/field:opacity-0">
        {status}
      </span>
      <Button
        variant="link"
        size="inline"
        className="text-xs opacity-0 transition-opacity duration-120 focus-visible:opacity-100 group-focus-within/field:opacity-100 group-hover/field:opacity-100"
        pending={confirm.isPending}
        onClick={() => confirm.start({ key: field.field.key, version: field.version })}
      >
        Подтвердить
      </Button>
    </span>
  )
}

/**
 * Поле разметки (DESIGN §5.4): подпись 13/18 серым, как у полей всех форм, состояние 12/16
 * справа, ниже значение. У черновика при наведении на месте состояния — «Подтвердить» (§4.4).
 * Конфликт версии встаёт строкой на месте поля с «Показать её вариант · Оставить мой».
 * После отказа ИИ «разметить вручную» ставит фокус в само поле; причина отказа — в подсказке.
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
  const { canAct } = useObjectPage()
  const labelId = useId()
  const valueRef = useRef<HTMLDivElement>(null)
  const focusValue = () =>
    valueRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
  const status = field ? (
    <FieldStatus
      status={field.status}
      confirmed={confirmedText(field, today)}
      source={field.source_hint ?? undefined}
      onManual={focusValue}
    />
  ) : null
  return (
    <div className="group/field flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <span id={labelId} className="text-ink-3 text-sm">
          {label}
        </span>
        {field && canAct && !conflict && CONFIRMABLE.has(field.status) ? (
          <ConfirmField field={field} status={status} />
        ) : field?.status === 'ai_failed' && field.source_hint ? (
          <span title={field.source_hint}>{status}</span>
        ) : (
          status
        )}
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
