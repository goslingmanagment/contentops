import { cn } from 'cn'
import type { ReactNode } from 'react'
import { Button } from './button'
import { StatusSign } from './status-sign'

interface LineAction {
  label: string
  onSelect: () => void
}

interface EmptyStateProps {
  /** Одна строка о том, что происходит: «Всё разобрано. Я.Диск проверен 4 мин назад». */
  children: ReactNode
  /** Прямой путь: «Сбросить», «Открыть Приехало». */
  action?: LineAction
  className?: string
}

/** Пусто (DESIGN §3.10): одна строка 14/20 по центру и прямой путь. */
export function EmptyState({ children, action, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn('flex h-full min-h-40 items-center justify-center px-6 text-center', className)}
    >
      <p className="text-base text-muted-foreground">
        {children}
        {action ? (
          <>
            {' · '}
            <Button variant="link" size="inline" onClick={action.onSelect}>
              {action.label}
            </Button>
          </>
        ) : null}
      </p>
    </div>
  )
}

interface ErrorLineProps {
  /** «Не удалось обновить — показано на 16:02» или «Не загрузилось». */
  message: string
  onRetry: () => void
  /** `inline` — строка над данными, которые есть; `center` — данных нет. */
  layout?: 'inline' | 'center'
  className?: string
}

/** Ошибка загрузки без путей и имён (§3.10, §3.13). */
export function ErrorLine({ message, onRetry, layout = 'inline', className }: ErrorLineProps) {
  const line = (
    <p role="alert" className="inline-flex items-center gap-2 text-base text-muted-foreground">
      <StatusSign kind="trouble" />
      <span>
        {message}
        {' · '}
        <Button variant="link" size="inline" onClick={onRetry}>
          Повторить
        </Button>
      </span>
    </p>
  )
  if (layout === 'center') {
    return (
      <div
        data-slot="error-line"
        className={cn('flex h-full min-h-40 items-center justify-center', className)}
      >
        {line}
      </div>
    )
  }
  return (
    <div data-slot="error-line" className={cn('flex min-h-9 items-center', className)}>
      {line}
    </div>
  )
}

interface ConflictLineProps {
  /** «Диана изменила название 1 мин назад». */
  message: string
  onShowTheirs: () => void
  onKeepMine: () => void
  /** Род того, кто изменил: «Показать её вариант» или «Показать его вариант». */
  theirsLabel?: string
  className?: string
}

/** Конфликт версии записи (412): строка на месте поля и два выхода (§3.10). */
export function ConflictLine({
  message,
  onShowTheirs,
  onKeepMine,
  theirsLabel = 'Показать её вариант',
  className,
}: ConflictLineProps) {
  return (
    <div
      data-slot="conflict-line"
      role="alert"
      className={cn(
        'flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-attention-bg px-3 py-1.5 text-sm',
        className,
      )}
    >
      <span className="inline-flex items-center gap-2 text-attention-ink">
        <StatusSign kind="turn" />
        {message}
      </span>
      <span className="inline-flex items-center gap-3">
        <Button variant="link" size="inline" onClick={onShowTheirs}>
          {theirsLabel}
        </Button>
        <Button variant="link" size="inline" onClick={onKeepMine}>
          Оставить мой
        </Button>
      </span>
    </div>
  )
}
