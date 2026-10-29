import { Input } from '@contentops/ui/components/input'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { Textarea } from '@contentops/ui/components/textarea'
import { type KeyboardEvent, useId, useState } from 'react'
import { FieldRow } from './field-row'
import type { DraftSave } from './use-draft-save'

interface DraftTextFieldProps {
  field: 'title' | 'description'
  label: string
  value: string
  source?: string | null
  multiline?: boolean
  placeholder?: string
  saver: DraftSave
}

/**
 * Текстовое поле черновика (DESIGN §3.13, п. 5): пока человек правит, фоновое обновление
 * не трогает его ввод. Сохраняется при уходе из поля или `Enter`; при конфликте ввод
 * остаётся, на месте поля — строка «Диана изменила название · Показать её вариант ·
 * Оставить мой».
 */
export function DraftTextField({
  field,
  label,
  value,
  source,
  multiline = false,
  placeholder,
  saver,
}: DraftTextFieldProps) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value
  const conflict = saver.conflict?.field === field ? saver.conflict : null

  const commit = async () => {
    if (draft === null) {
      return
    }
    if (draft.trim() === value) {
      setDraft(null)
      return
    }
    if (await saver.save({ [field]: draft.trim() })) {
      setDraft(null)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur()
    }
    if (event.key === 'Escape') {
      setDraft(null)
    }
  }

  return (
    <FieldRow
      label={label}
      htmlFor={id}
      source={source}
      aside={saver.savingField === field ? 'сохраняется…' : null}
    >
      {multiline ? (
        <Textarea
          id={id}
          value={shown}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          className="min-h-16"
        />
      ) : (
        <Input
          id={id}
          value={shown}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
        />
      )}
      {conflict ? (
        <ConflictLine
          message={conflict.message}
          theirsLabel={conflict.theirsLabel}
          onShowTheirs={() => {
            setDraft(null)
            void saver.showTheirs()
          }}
          onKeepMine={() => void saver.keepMine()}
        />
      ) : null}
    </FieldRow>
  )
}
