import { LockIcon } from 'lucide-react'
import { FieldMessage } from '@/shell/field/field-message'

interface ForbiddenStateProps {
  /** «Нет доступа к этой модели» или «Нет доступа к этому разделу». */
  message?: string
}

/** 403 на месте поля (DESIGN §3.10): есть ли объект, не говорится. */
export function ForbiddenState({ message = 'Нет доступа к этой модели' }: ForbiddenStateProps) {
  return (
    <FieldMessage>
      <LockIcon aria-hidden className="size-6 text-ink-3" />
      <p className="text-lg">{message}</p>
    </FieldMessage>
  )
}
