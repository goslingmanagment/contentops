import { Input } from '@contentops/ui/components/input'
import { type KeyboardEvent, useState } from 'react'
import { useObjectPage } from '../../object-context'
import { FieldRow } from './field-row'
import { useFieldSave } from './use-field-save'
import { useMarkupField } from './use-markup-field'

interface TitleFieldProps {
  /** `title_en` — короткое английское название для имени скачивания (naming §4). */
  fieldKey?: 'title' | 'title_en'
  label?: string
  /**
   * Подсказка в пустом поле для того, кто может его заполнить. «не заполнено» уже стоит
   * справа от подписи (§5.4) — второй раз на месте значения оно не пишется.
   */
  hint?: string
}

/** «Название» в разметке: то же поле, что в шапке, правка на месте. */
export function TitleField({ fieldKey = 'title', label = 'Название', hint }: TitleFieldProps) {
  const { canAct } = useObjectPage()
  const field = useMarkupField(fieldKey)
  const save = useFieldSave(fieldKey)
  // Версия поля, с которой начата правка: чужое изменение за это время — конфликт, не перезапись.
  const [editing, setEditing] = useState<{ base: number } | null>(null)
  const value = field?.field.key === fieldKey ? field.field.value : ''

  return (
    <FieldRow
      label={label}
      field={field}
      conflict={save.conflict}
      onShowTheirs={save.showTheirs}
      onKeepMine={() => void save.keepMine()}
    >
      {(labelId) =>
        editing ? (
          <TitleInput
            labelId={labelId}
            initial={value}
            onFinish={(next) => {
              setEditing(null)
              const trimmed = next?.trim()
              if (trimmed && trimmed !== value) {
                save.save({ key: fieldKey, value: trimmed }, editing.base)
              }
            }}
          />
        ) : (
          <button
            type="button"
            disabled={!canAct}
            aria-labelledby={labelId}
            onClick={() => setEditing({ base: field?.version ?? 1 })}
            className="-mx-2 min-h-9 rounded-lg px-2 text-left transition-colors duration-120 enabled:hover:bg-accent"
          >
            {value || <span className="text-ink-3">{(canAct && hint) || 'не заполнено'}</span>}
          </button>
        )
      }
    </FieldRow>
  )
}

function TitleInput({
  labelId,
  initial,
  onFinish,
}: {
  labelId: string
  initial: string
  onFinish: (value: string | null) => void
}) {
  const [value, setValue] = useState(initial)
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onFinish(value)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onFinish(null)
    }
  }
  return (
    <Input
      autoFocus
      aria-labelledby={labelId}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => onFinish(value)}
    />
  )
}
