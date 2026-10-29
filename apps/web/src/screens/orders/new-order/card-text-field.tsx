import type { OrderFields } from '@contentops/contracts'
import { Textarea } from '@contentops/ui/components/textarea'
import { PencilIcon } from 'lucide-react'
import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react'
import { type UseFormReturn, useWatch } from 'react-hook-form'
import { textOrNull } from '../form-values'

/** Карточка одной строкой: строки Telegram через « · », как в строке заказа. */
function oneLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' · ')
}

function isPaste(event: ChangeEvent<HTMLTextAreaElement>): boolean {
  const input = event.nativeEvent
  return input instanceof InputEvent && input.inputType === 'insertFromPaste'
}

/**
 * Текст карточки в «Новом заказе» (DESIGN §4.16): пустое поле — место для вставки; после
 * вставки текст сворачивается в одну строку, чтобы разобранные поля были видны целиком.
 * Нажатие на строку разворачивает текст обратно. Набранный руками текст не сворачивается:
 * поле не прыгает под курсором.
 */
export function CardTextField({ form }: { form: UseFormReturn<OrderFields> }) {
  const id = useId()
  const text = useWatch({ control: form.control, name: 'card_text' }) ?? ''
  const [editing, setEditing] = useState(true)
  const focusNext = useRef<'text' | 'line' | null>(null)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const lineRef = useRef<HTMLButtonElement>(null)
  const collapsed = !editing && text.trim() !== ''
  const { ref, onChange, ...field } = form.register('card_text', {
    setValueAs: textOrNull,
  })

  // Фокус переходит на то, что встало на место: развёрнутый текст или его строку.
  useEffect(() => {
    const target = focusNext.current === 'text' ? textRef.current : lineRef.current
    if (focusNext.current === null || !target) return
    focusNext.current = null
    target.focus()
    if (target instanceof HTMLTextAreaElement) {
      target.setSelectionRange(target.value.length, target.value.length)
    }
  })

  if (collapsed) {
    return (
      <button
        ref={lineRef}
        type="button"
        onClick={() => {
          focusNext.current = 'text'
          setEditing(true)
        }}
        aria-label={`Текст карточки: ${oneLine(text)}. Изменить`}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-3 text-left text-base outline-none transition-colors duration-120 hover:bg-accent focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate">{oneLine(text)}</span>
        <PencilIcon aria-hidden className="size-4 shrink-0 text-ink-3" />
      </button>
    )
  }

  return (
    <>
      <label htmlFor={id} className="sr-only">
        Текст карточки
      </label>
      <Textarea
        id={id}
        autoFocus
        rows={3}
        placeholder="Текст карточки из Telegram"
        className="field-sizing-fixed h-20 resize-none"
        {...field}
        ref={(element) => {
          ref(element)
          textRef.current = element
        }}
        onChange={(event) => {
          void onChange(event)
          if (isPaste(event) && event.target.value.trim() !== '') {
            focusNext.current = 'line'
            setEditing(false)
          }
        }}
      />
    </>
  )
}
