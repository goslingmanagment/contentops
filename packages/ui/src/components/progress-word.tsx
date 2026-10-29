import { formatPercent } from '@contentops/contracts/format'
import { cn } from 'cn'
import type { ComponentProps } from 'react'
import { Progress } from './progress'

interface ProgressWordProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** Что происходит: «сжимается», «готовится», «Превью собирается». */
  label: string
  /** Ход, 0–100. */
  value: number
  /** Своя подпись вместо «<label> 62 %»: «качается 3,2 из 5,8 ГБ». */
  text?: string
}

/** Серое слово долгой операции с тонкой полоской 2 px под ним (DESIGN §5.1). */
export function ProgressWord({ label, value, text, className, ...props }: ProgressWordProps) {
  const caption = text ?? `${label} ${formatPercent(Math.min(100, Math.max(0, value)) / 100)}`
  return (
    <span
      data-slot="progress-word"
      className={cn('inline-flex min-w-0 flex-col gap-1 text-muted-foreground text-sm', className)}
      {...props}
    >
      <span className="truncate tabular-nums">{caption}</span>
      <Progress value={value} aria-label={caption} className="h-0.5" />
    </span>
  )
}
