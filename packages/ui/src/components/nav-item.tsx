import { formatNumber } from '@contentops/contracts/format'
import { cn } from 'cn'
import type { ComponentType } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'
import { UiLink } from './ui-link'

interface NavItemProps {
  href: string
  icon: ComponentType<{ className?: string }>
  label: string
  /** Серое число справа; у пункта либо число, либо ничего (§2.2). */
  count?: number
  /** Красное число — только при ▲ «пропущено» в Плане. */
  countTone?: 'muted' | 'danger'
  active?: boolean
  /** Колонка свёрнута в значки (окно уже 1100): подпись уходит в подсказку. */
  collapsed?: boolean
}

/**
 * Пункт левой колонки (DESIGN §2.2): 40, значок 18, слово 14/20, счётчик 13. Активный —
 * белая подложка, слово 600, значок синий.
 */
export function NavItem({
  href,
  icon: Icon,
  label,
  count,
  countTone = 'muted',
  active = false,
  collapsed = false,
}: NavItemProps) {
  const link = (
    <UiLink
      href={href}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn(
        'group flex h-10 items-center gap-3 rounded-lg px-3 text-base text-sidebar-foreground transition-colors duration-120 hover:bg-sidebar-accent/60 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="size-4.5 shrink-0 text-muted-foreground group-aria-[current=page]:text-sidebar-primary" />
      {collapsed ? null : <span className="min-w-0 flex-1 truncate">{label}</span>}
      {collapsed || count === undefined ? null : (
        <span
          className={cn(
            'font-normal text-sm tabular-nums',
            countTone === 'danger' ? 'text-destructive' : 'text-ink-3',
          )}
        >
          {formatNumber(count)}
        </span>
      )}
    </UiLink>
  )
  if (!collapsed) {
    return link
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {count === undefined ? null : ` · ${formatNumber(count)}`}
      </TooltipContent>
    </Tooltip>
  )
}
