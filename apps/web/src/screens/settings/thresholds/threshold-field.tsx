import type { Threshold, UpdateThresholdCommand } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@contentops/ui/components/input-group'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { type FormEvent, type ReactNode, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { draftOf, parseDraft } from './threshold-value'

const INVALIDATES = [queryKeys.thresholds()]

/**
 * Правка значения порога или исключения: «Сохранить» появляется при правке, «сохранено» —
 * только после ответа сервера, чужая правка — строкой конфликта (§3.10).
 */
export function useThresholdEdit(threshold: Threshold, where: string | null) {
  const api = useApi()
  const toast = useActionToast()
  const [draft, setDraft] = useState(() => draftOf(threshold.value))
  const save = useVersionedSave<UpdateThresholdCommand, Threshold>({
    subject: 'порог',
    failed: 'Порог не сохранился',
    invalidates: INVALIDATES,
    run: (body, version, key) =>
      api.admin.updateThreshold({ body, ifMatch: version, idempotencyKey: key }),
    onSuccess: (saved) => {
      const name = where ? `${saved.label} · ${where}` : saved.label
      toast.show({ message: saved.value === null ? `${name}: выключено` : `Сохранено · ${name}` })
    },
  })

  const parsed = parseDraft(draft)
  const invalid = parsed === undefined
  const dirty = !invalid && parsed !== threshold.value

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (dirty && parsed !== undefined) {
      save.save(
        {
          key: threshold.key,
          scope: threshold.scope,
          scope_value: threshold.scope_value,
          value: parsed,
        },
        threshold.version,
      )
    }
  }

  return { draft, setDraft, invalid, dirty, off: parsed === null, submit, save }
}

type ThresholdEdit = ReturnType<typeof useThresholdEdit>

/** Строка конфликта под порогом: «Дмитрий изменил порог 1 мин назад · …». */
export function ThresholdConflict({ edit }: { edit: ThresholdEdit }) {
  const { conflict, showTheirs, keepMine } = edit.save
  if (!conflict) {
    return null
  }
  return (
    <ConflictLine
      message={conflict.message}
      theirsLabel={conflict.theirsLabel}
      onShowTheirs={showTheirs}
      onKeepMine={() => keepMine()}
      className="mb-3"
    />
  )
}

interface ThresholdFieldProps {
  threshold: Threshold
  edit: ThresholdEdit
  inputId?: string
  /** Имя поля, когда рядом нет видимой подписи: «Слишком рано для Лайф». */
  inputLabel?: string
  /** Перед полем: «Убрать» у исключения. */
  actions?: ReactNode
}

/** Справа в строке: «не задано — функция выключена», «Сохранить» и поле с единицей. */
export function ThresholdField({
  threshold,
  edit,
  inputId,
  inputLabel,
  actions,
}: ThresholdFieldProps) {
  return (
    <form onSubmit={edit.submit} className="flex items-center gap-3">
      <span className="text-ink-3 text-sm">
        {edit.off ? 'не задано — функция выключена' : null}
      </span>
      {edit.dirty ? (
        <Button type="submit" variant="outline" size="sm" pending={edit.save.isPending}>
          Сохранить
        </Button>
      ) : null}
      {actions}
      <InputGroup className="w-32">
        <InputGroupInput
          id={inputId}
          aria-label={inputLabel}
          inputMode="decimal"
          value={edit.draft}
          aria-invalid={edit.invalid}
          placeholder="—"
          onChange={(event) => edit.setDraft(event.target.value)}
          className="text-right tabular-nums"
        />
        {threshold.unit ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{threshold.unit}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </form>
  )
}
