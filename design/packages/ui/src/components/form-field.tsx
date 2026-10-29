import { cn } from 'cn'
import type { ReactNode } from 'react'

interface FormFieldProps {
  /** `id` поля: подпись нажимается и читается вместе с ним. */
  htmlFor: string
  label: string
  /** Серая подсказка под полем: «Латиница, цифры, точка». */
  hint?: string
  /** Ошибка схемы из `packages/contracts`; место под неё держится, форма не прыгает. */
  error?: string
  children: ReactNode
  className?: string
}

/** Поле формы окна (DESIGN §3.9): подпись 13 серым, поле 36, строка ошибки. */
export function FormField({ htmlFor, label, hint, error, children, className }: FormFieldProps) {
  return (
    <div data-slot="form-field" className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-ink-3 text-sm">
        {label}
      </label>
      {children}
      <p
        id={`${htmlFor}-message`}
        className={cn('min-h-4 text-xs', error ? 'text-destructive' : 'text-ink-3')}
      >
        {error ?? hint ?? null}
      </p>
    </div>
  )
}
