import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import type { ReactNode } from 'react'

interface FieldRowProps {
  label: string
  htmlFor?: string
  /** Откуда взялось значение — в подсказке при наведении на подпись (§4.8, п. 2). */
  source?: string | null
  /** Справа от подписи: «сохраняется…». */
  aside?: ReactNode
  children: ReactNode
}

/** Поле черновика: подпись 13/18 серым над полем, источник значения — в подсказке. */
export function FieldRow({ label, htmlFor, source, aside, children }: FieldRowProps) {
  const caption = (
    <label htmlFor={htmlFor} className="text-ink-3 text-sm">
      {label}
    </label>
  )
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-4.5 items-center justify-between gap-2">
        {source ? (
          <Tooltip>
            <TooltipTrigger asChild>{caption}</TooltipTrigger>
            <TooltipContent>{source}</TooltipContent>
          </Tooltip>
        ) : (
          caption
        )}
        {aside ? <span className="text-ink-3 text-xs">{aside}</span> : null}
      </div>
      {children}
    </div>
  )
}
