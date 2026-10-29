import { formatNumber } from '@contentops/contracts/format'
import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import { Children, type ReactNode } from 'react'
import { Button } from './button'
import { DarkSurface } from './dark-surface'
import { ItemMenuButton, type ItemMenuModel } from './item-menu'

interface SelectionBarProps {
  count: number
  onClear: () => void
  /**
   * Кнопки действий: первая — `variant="default"` (в тёмной полосе она белая), остальные —
   * `variant="bar"`. Неприменимые кнопки не показываются (§3.3).
   */
  children: ReactNode
  /** Меню «⋯» полосы; меню тёмное. */
  menu?: ItemMenuModel
  className?: string
}

/**
 * Первая показанная кнопка — белая залитая (§3.3), кто бы ни стоял первым: «Скачать 1»,
 * когда отмечать нечего, или раздвоенная «Скачать ▾» целиком.
 */
const FIRST_ACTION_FILLED = cn(
  '[&>[data-variant=bar]:first-child]:bg-primary [&>[data-variant=bar]:first-child]:text-primary-foreground [&>[data-variant=bar]:first-child]:hover:bg-primary-hover',
  '[&>:first-child:not([data-slot=button])>[data-variant=bar]]:bg-primary [&>:first-child:not([data-slot=button])>[data-variant=bar]]:text-primary-foreground [&>:first-child:not([data-slot=button])>[data-variant=bar]]:hover:bg-primary-hover',
)

/**
 * Полоса выделения (DESIGN §3.3): тёмная полоса 56 с радиусом 14 встаёт на место шапки
 * поля той же высоты, сетка не сдвигается. Без кнопок действий полосы нет: щелчок только
 * выбирает и обновляет панель, шапка остаётся (одно «⋯» шапку не заменяет).
 */
export function SelectionBar({ count, onClear, children, menu, className }: SelectionBarProps) {
  if (Children.toArray(children).length === 0) {
    return null
  }
  return (
    <DarkSurface
      role="toolbar"
      aria-label={`Выбрано: ${formatNumber(count)}`}
      className={cn(
        'flex h-14 min-w-0 items-center gap-1 rounded-2xl bg-bar px-2 duration-120 animate-in fade-in-0',
        className,
      )}
    >
      <Button variant="bar" size="icon" aria-label="Снять выделение" onClick={onClear}>
        <XIcon />
      </Button>
      <span className="mr-3 whitespace-nowrap font-medium text-base tabular-nums">
        Выбрано: {formatNumber(count)}
      </span>
      <div className={cn('flex min-w-0 items-center gap-1', FIRST_ACTION_FILLED)}>{children}</div>
      {menu ? <ItemMenuButton menu={menu} variant="bar" className="ml-auto" /> : null}
    </DarkSurface>
  )
}
