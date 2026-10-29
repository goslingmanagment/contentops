import { cn } from 'cn'
import type { ReactNode } from 'react'
import { Button } from './button'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import type { StatusKind } from './status-sign'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

export interface WhyAction {
  label: string
  onSelect: () => void
}

interface WhyPopoverProps {
  /** Слово или знак, по которому открывается «почему». */
  children: ReactNode
  /** Короткая подсказка при наведении. */
  hint?: string
  /** Верх всплывашки: обычно то же слово со знаком. */
  title?: ReactNode
  /** Тон верха: ◆ — янтарный фон, ▲ — красный (§7.1). */
  tone?: StatusKind
  /** Факты строками: «В плане на 20:00 · поставила Диана 19.09». */
  facts: readonly string[]
  /** Одна кнопка по случаю, например «Сверить». */
  action?: WhyAction
  align?: 'start' | 'center' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

const toneClass: Record<StatusKind, string> = {
  done: 'bg-accent',
  turn: 'bg-attention-bg',
  trouble: 'bg-destructive-bg',
}

/**
 * «Почему» у состояния (DESIGN §5.1): нажатие или `Enter` открывает всплывашку 320 с тремя
 * фактами и одной кнопкой; наведение показывает короткую подсказку.
 */
export function WhyPopover({
  children,
  hint,
  title,
  tone,
  facts,
  action,
  align = 'start',
  open,
  onOpenChange,
  className,
}: WhyPopoverProps) {
  const trigger = (
    <PopoverTrigger asChild>
      <button
        type="button"
        className={cn(
          'inline-flex max-w-full items-center rounded-sm text-left decoration-line-strong decoration-dotted underline-offset-4 hover:underline',
          className,
        )}
      >
        {children}
      </button>
    </PopoverTrigger>
  )
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <PopoverContent align={align} className="w-80 gap-0 overflow-hidden p-0">
        {title ? (
          <div className={cn('px-4 py-3', tone ? toneClass[tone] : 'border-border border-b')}>
            {title}
          </div>
        ) : null}
        <ul className="flex flex-col gap-1.5 px-4 py-3 text-base">
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        {action ? (
          <div className="px-4 pb-4">
            <Button variant="outline" size="sm" onClick={action.onSelect}>
              {action.label}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
