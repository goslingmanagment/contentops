import { type StatusKind, StatusSign } from '@contentops/ui/components/status-sign'
import { cn } from '@contentops/ui/lib/utils'
import type { ReactNode } from 'react'

/** Цвет слова по знаку, как у `StatusWord`: ✓ — основной, ◆ — янтарный, ▲ — красный. */
const TONE: Record<StatusKind | 'none', string> = {
  done: 'text-foreground',
  turn: 'text-attention-ink',
  trouble: 'text-destructive',
  none: 'text-muted-foreground',
}

interface StatusLineProps {
  sign?: StatusKind
  /** Уточнение серым после точки: «вручную, Диана», «Отчёт о выполнении». */
  detail?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Состояние словом (DESIGN §5.1), которое переносится, а не обрезается: в панели важен
 * хвост — кто подтвердил и как. Знак держится у первой строки.
 */
export function StatusLine({ sign, detail, children, className }: StatusLineProps) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-start gap-1.5 text-sm transition-colors duration-160',
        TONE[sign ?? 'none'],
        className,
      )}
    >
      {sign ? <StatusSign kind={sign} className="mt-0.5 shrink-0" /> : null}
      <span className="min-w-0">
        {children}
        {detail ? <span className="text-ink-3"> · {detail}</span> : null}
      </span>
    </span>
  )
}
