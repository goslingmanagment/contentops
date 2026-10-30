import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import { useEffect, useId, useRef, useState } from 'react'

interface ReasonFormProps {
  /** «Почему снимаем заказ», «Почему отвязываем сдачу». */
  label: string
  /** Частые причины одним нажатием: «возврат», «отказ фана», «дубль карточки». */
  choices: readonly string[]
  submitLabel: string
  pending: boolean
  onSubmit: (reason: string) => void
  onCancel: () => void
}

/**
 * Причина словами — обязательна (SPEC §5: «снят» с причиной; отзыв сдачи — новой записью с
 * причиной). Готовые варианты ставят текст, его можно дописать.
 */
export function ReasonForm({
  label,
  choices,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: ReasonFormProps) {
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)
  const id = useId()
  const rootRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])
  const empty = reason.trim() === ''
  return (
    <form
      ref={rootRef}
      onSubmit={(event) => {
        event.preventDefault()
        setTried(true)
        if (!empty) onSubmit(reason.trim())
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
      className="flex flex-col gap-2 rounded-xl border border-border p-3"
    >
      <label htmlFor={id} className="text-ink-3 text-sm">
        {label}
      </label>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((choice) => (
          <Button
            key={choice}
            type="button"
            size="sm"
            variant={reason === choice ? 'secondary' : 'outline'}
            onClick={() => setReason(choice)}
          >
            {choice}
          </Button>
        ))}
      </div>
      <Input
        id={id}
        autoFocus
        value={reason}
        placeholder="Или своими словами"
        aria-invalid={tried && empty ? true : undefined}
        onChange={(event) => setReason(event.target.value)}
      />
      {tried && empty ? <p className="text-destructive text-sm">Нужна причина</p> : null}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" variant="outline" pending={pending}>
          {submitLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  )
}
