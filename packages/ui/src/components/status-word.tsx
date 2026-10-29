import { cn } from 'cn'
import type { ComponentProps, ReactNode } from 'react'
import { type StatusKind, StatusSign } from './status-sign'

const wordTone: Record<StatusKind | 'none', string> = {
  done: 'text-foreground',
  turn: 'text-attention-ink',
  trouble: 'text-destructive',
  none: 'text-muted-foreground',
}

interface StatusWordProps extends ComponentProps<'span'> {
  /** Знак ✓ ◆ ▲. Без знака слово серое: «в плане», «отмечено», «не видели». */
  sign?: StatusKind
  /** Уточнение серым после точки: «Hub, по имени файла». */
  detail?: ReactNode
  /** 13/18 по умолчанию, 12/16 в ячейках недели и у полей разметки. */
  size?: 'sm' | 'xs'
}

/**
 * Состояние словом (DESIGN §5.1): рядом со знаком всегда слово, смена — плавно за 160 мс.
 */
export function StatusWord({
  sign,
  detail,
  size = 'sm',
  className,
  children,
  ...props
}: StatusWordProps) {
  return (
    <span
      data-slot="status-word"
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 transition-colors duration-160',
        size === 'sm' ? 'text-sm' : 'text-xs',
        wordTone[sign ?? 'none'],
        className,
      )}
      {...props}
    >
      {sign ? <StatusSign kind={sign} size={size === 'sm' ? 14 : 12} /> : null}
      <span className="truncate">
        {children}
        {detail ? <span className="text-ink-3"> · {detail}</span> : null}
      </span>
    </span>
  )
}
