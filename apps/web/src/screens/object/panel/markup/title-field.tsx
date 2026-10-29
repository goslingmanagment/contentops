import { Input } from '@contentops/ui/components/input'
import { type KeyboardEvent, useState } from 'react'
import { useObjectPage } from '../../object-context'
import { FieldRow } from './field-row'
import { useFieldSave } from './use-field-save'
import { useMarkupField } from './use-markup-field'

/** «Название» в разметке: то же поле, что в шапке, правка на месте. */
export function TitleField() {
  const { canAct } = useObjectPage()
  const field = useMarkupField('title')
  const save = useFieldSave('title')
  const [editing, setEditing] = useState(false)
  const value = field?.field.key === 'title' ? field.field.value : ''

  return (
    <FieldRow
      label="Название"
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
              setEditing(false)
              const trimmed = next?.trim()
              if (trimmed && trimmed !== value) {
                save.save({ key: 'title', value: trimmed })
              }
            }}
          />
        ) : (
          <button
            type="button"
            disabled={!canAct}
            aria-labelledby={labelId}
            onClick={() => setEditing(true)}
            className="-mx-2 min-h-9 rounded-lg px-2 text-left transition-colors duration-120 enabled:hover:bg-accent"
          >
            {value || <span className="text-ink-3">не заполнено</span>}
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
