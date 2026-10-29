import { type AddRevisionCommand, AddRevisionCommandSchema } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import { Textarea } from '@contentops/ui/components/textarea'
import { hasModifierKey } from '@contentops/ui/lib/platform'
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { textOrNull } from '../form-values'

interface RevisionFormProps {
  pending: boolean
  onSubmit: (body: AddRevisionCommand) => void
  onCancel: () => void
}

/**
 * «Добавить правку» (DESIGN §4.16, п. 5; сценарий §6.6): требование и ссылка на
 * сообщение, «Сохранить». Форма закрывается только после ответа сервера.
 */
export function RevisionForm({ pending, onSubmit, onCancel }: RevisionFormProps) {
  const form = useForm<AddRevisionCommand>({
    resolver: zodResolver(AddRevisionCommandSchema),
    defaultValues: { text: '', message_url: null },
  })
  const rootRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])
  const error = form.formState.errors.text?.message
  const submit = form.handleSubmit(onSubmit)
  return (
    <form
      ref={rootRef}
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
        if (event.key === 'Enter' && hasModifierKey(event)) void submit()
      }}
      className="flex flex-col gap-2 rounded-xl border border-border p-3"
    >
      <Textarea
        autoFocus
        rows={2}
        placeholder="Что поправить: «без музыки, только звук комнаты»"
        aria-label="Что поправить"
        aria-invalid={error ? true : undefined}
        className="min-h-16"
        {...form.register('text')}
      />
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <Input
        placeholder="Ссылка на сообщение в Telegram"
        aria-label="Ссылка на сообщение"
        {...form.register('message_url', { setValueAs: textOrNull })}
      />
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" variant="outline" pending={pending}>
          Сохранить
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  )
}
