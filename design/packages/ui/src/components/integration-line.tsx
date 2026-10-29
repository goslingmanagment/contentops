import { cn } from 'cn'
import { CloudOffIcon, KeyRoundIcon, PowerOffIcon, RefreshCwIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { Button } from './button'

/** Пять состояний интеграции (DESIGN §3.11). */
export type IntegrationState = 'ok' | 'off' | 'unset' | 'down' | 'catching-up'

interface IntegrationLineProps extends ComponentProps<'div'> {
  state: IntegrationState
  /** Кнопка только для владельца: «Включить», «Настроить», «Подробнее». */
  action?: { label: string; onSelect: () => void }
  /** Переносить фразу, а не обрезать (узкая карточка места). */
  wrap?: boolean
}

function StateIcon({ state }: { state: IntegrationState }) {
  switch (state) {
    case 'ok':
      return <span aria-hidden className="mx-1 size-1.5 shrink-0 rounded-full bg-ink-3" />
    case 'off':
      return <PowerOffIcon aria-hidden className="size-4 shrink-0 text-ink-3" />
    case 'unset':
      return <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-ink-3" />
    case 'down':
      return <CloudOffIcon aria-hidden className="size-4 shrink-0 text-attention" />
    case 'catching-up':
      return <RefreshCwIcon aria-hidden className="size-4 shrink-0 text-ink-3" />
  }
}

/**
 * Строка состояния интеграции: значок, фраза и кнопка владельцу. Цветного баннера нет:
 * янтарь только у «временно недоступно», значок «догоняет» не вращается.
 */
export function IntegrationLine({
  state,
  action,
  wrap = false,
  className,
  children,
  ...props
}: IntegrationLineProps) {
  return (
    <div
      data-slot="integration-line"
      data-state={state}
      className={cn(
        'inline-flex min-w-0 gap-2 text-sm',
        wrap ? 'items-start [&>svg]:mt-0.5' : 'items-center',
        state === 'down' ? 'text-attention-ink' : 'text-muted-foreground',
        className,
      )}
      {...props}
    >
      <StateIcon state={state} />
      <span className={cn('min-w-0', !wrap && 'truncate')}>{children}</span>
      {action ? (
        <Button variant="link" size="sm" className="shrink-0" onClick={action.onSelect}>
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}
