import { cn } from 'cn'
import { CheckIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from './badge'
import { Button } from './button'

/** Состояние поля разметки (DESIGN §5.4). */
export type FieldStatusKind =
  | 'empty'
  | 'draft_ai'
  | 'draft_import'
  | 'confirmed'
  | 'confirmed_previous_version'
  | 'ai_failed'

interface FieldStatusProps {
  status: FieldStatusKind
  /** «Диана 12.08» — кто и когда подтвердил. */
  confirmed?: string
  /** Откуда черновик: «из имени папки», «из старого имени». */
  source?: string
  /** «разметить вручную» после отказа сервиса ИИ. */
  onManual?: () => void
  className?: string
}

/**
 * Состояние справа от названия поля, 12/16 серым. Черновик ИИ не янтарный: после ИИ он
 * будет почти у каждого объекта, и цвет превратил бы поле в крик (§4.20).
 */
export function FieldStatus({ status, confirmed, source, onManual, className }: FieldStatusProps) {
  const content: Record<FieldStatusKind, ReactNode> = {
    empty: 'не заполнено',
    draft_ai: (
      <>
        черновик
        <Badge variant="outline" className="h-4 px-1">
          ИИ
        </Badge>
      </>
    ),
    draft_import: `черновик · ${source ?? 'импорт'}`,
    confirmed: (
      <>
        <CheckIcon aria-hidden className="size-3" />
        {confirmed ? `подтверждено · ${confirmed}` : 'подтверждено'}
      </>
    ),
    confirmed_previous_version: (
      <>
        подтверждено для прежней версии
        <Badge variant="outline" className="h-4 px-1">
          v1
        </Badge>
      </>
    ),
    ai_failed: (
      <>
        не удалось ·
        <Button variant="link" size="inline" className="text-xs" onClick={onManual}>
          разметить вручную
        </Button>
      </>
    ),
  }
  return (
    <span
      data-slot="field-status"
      data-status={status}
      className={cn('inline-flex min-w-0 items-center gap-1 text-ink-3 text-xs', className)}
    >
      {content[status]}
    </span>
  )
}
