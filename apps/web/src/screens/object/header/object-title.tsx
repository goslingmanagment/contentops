import { Input } from '@contentops/ui/components/input'
import { cn } from '@contentops/ui/lib/utils'
import { type KeyboardEvent, useState } from 'react'
import { useObjectPage } from '../object-context'
import type { FieldSave } from '../panel/markup/use-field-save'

/**
 * Название объекта 20/28 (DESIGN §4.4): нажатие — правка на месте, `Enter` сохраняет,
 * `Esc` возвращает прежнее. Пока сервер не ответил, видно введённое; «Сохранено» — после.
 * Конфликт версии встаёт строкой под шапкой: в строке названия ему тесно.
 */
export function ObjectTitle({ field }: { field: FieldSave }) {
  const { detail, canAct } = useObjectPage()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(detail.entry.title)
  const title = field.pending ? draft : detail.entry.title

  if (editing) {
    const finish = (next: string | null) => {
      setEditing(false)
      const value = next?.trim()
      if (value && value !== detail.entry.title) {
        setDraft(value)
        field.save({ key: 'title', value })
      }
    }
    return <TitleInput initial={detail.entry.title} onFinish={finish} />
  }
  return (
    <h1 className="flex min-w-0 font-heading text-xl">
      {canAct ? (
        <button
          type="button"
          title="Изменить название"
          onClick={() => {
            setDraft(detail.entry.title)
            setEditing(true)
          }}
          className={cn(
            '-mx-1.5 min-w-0 truncate rounded-md px-1.5 text-left transition-colors duration-120 hover:bg-accent',
            field.pending && 'text-muted-foreground',
          )}
        >
          {title}
        </button>
      ) : (
        <span className="truncate">{title}</span>
      )}
    </h1>
  )
}

function TitleInput({
  initial,
  onFinish,
}: {
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
      aria-label="Название"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => onFinish(value)}
      className="h-9 min-w-0 max-w-120 flex-1 font-heading text-xl"
    />
  )
}
