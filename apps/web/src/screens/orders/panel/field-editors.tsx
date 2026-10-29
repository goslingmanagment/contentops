import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import { Textarea } from '@contentops/ui/components/textarea'
import { hasModifierKey } from '@contentops/ui/lib/platform'
import { cn } from '@contentops/ui/lib/utils'
import { type KeyboardEvent, type ReactNode, useState } from 'react'

/**
 * Правка поля на месте (DESIGN §4.16: «Всё правится на месте»): нажатие на значение
 * открывает поле ввода, `Enter` сохраняет, `Esc` отменяет. Черновик живёт в самом
 * редакторе, поэтому фоновое обновление заказа его не сбрасывает (§3.13, п. 5).
 */

interface FieldRowProps {
  label: string
  children: ReactNode
  /** Строка под полем: конфликт версии. */
  below?: ReactNode
}

export function FieldRow({ label, children, below }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3">
        <dt className="text-ink-3 text-sm">{label}</dt>
        <dd className="min-w-0 text-base">{children}</dd>
      </div>
      {below}
    </div>
  )
}

interface EditTriggerProps {
  children: ReactNode
  onEdit: () => void
  /** Без прав на правку значение — просто текст. */
  editable: boolean
}

/** Значение поля; у того, кто может править, — кнопка, открывающая правку. */
export function EditTrigger({ children, onEdit, editable }: EditTriggerProps) {
  if (!editable) {
    return <span className="block min-w-0 break-words">{children}</span>
  }
  return (
    <button
      type="button"
      onClick={onEdit}
      className="-mx-1.5 -my-0.5 block w-[calc(100%+0.75rem)] min-w-0 rounded-md px-1.5 py-0.5 text-left transition-colors duration-120 hover:bg-accent"
    >
      <span className="break-words">{children}</span>
      <span className="sr-only"> — изменить</span>
    </button>
  )
}

/** Пустое поле — нормальное состояние, пишется серым (§2.5). */
export function Unset({ children = 'не заполнено' }: { children?: string }) {
  return <span className="text-ink-3">{children}</span>
}

interface EditorActionsProps {
  pending: boolean
  onSave: () => void
  onCancel: () => void
}

function EditorActions({ pending, onSave, onCancel }: EditorActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" pending={pending} onClick={onSave}>
        Сохранить
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Отмена
      </Button>
    </div>
  )
}

interface TextEditorProps {
  initial: string
  multiline?: boolean
  type?: 'text' | 'date'
  placeholder?: string
  pending: boolean
  onSave: (value: string) => void
  onCancel: () => void
  label: string
}

/** Одна строка или несколько (ТЗ): в многострочном `Ctrl Enter` сохраняет. */
export function TextEditor({
  initial,
  multiline = false,
  type = 'text',
  placeholder,
  pending,
  onSave,
  onCancel,
  label,
}: TextEditorProps) {
  const [draft, setDraft] = useState(initial)
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key === 'Enter' && (!multiline || hasModifierKey(event.nativeEvent))) {
      event.preventDefault()
      onSave(draft)
    }
  }
  const common = {
    value: draft,
    placeholder,
    autoFocus: true,
    'aria-label': label,
    onKeyDown,
  }
  return (
    <div className="flex flex-col gap-2">
      {multiline ? (
        <Textarea
          {...common}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-18"
        />
      ) : (
        <Input
          {...common}
          type={type}
          onChange={(event) => setDraft(event.target.value)}
          className={cn(type === 'date' && 'w-44')}
        />
      )}
      <EditorActions pending={pending} onSave={() => onSave(draft)} onCancel={onCancel} />
    </div>
  )
}

export { EditorActions }
