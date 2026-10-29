import { cn } from 'cn'
import type { ReactNode } from 'react'
import { Progress } from './progress'
import { UiLink } from './ui-link'

interface SpaceCardProps {
  /** Нажатие открывает «Настройки › Состояние». */
  href: string
  /** «C: свободно 612 ГБ», после переезда — «Занято 0,52 из 2 ТБ». */
  label: string
  usedPercent: number
  /** Строки только когда что-то не так: `IntegrationLine` «недоступно» и «догоняет». */
  children?: ReactNode
  className?: string
}

/** Карточка места внизу колонки (DESIGN §2.2): белая, радиус 12, полоска и подпись. */
export function SpaceCard({ href, label, usedPercent, children, className }: SpaceCardProps) {
  return (
    <UiLink
      href={href}
      data-slot="space-card"
      className={cn(
        'flex flex-col gap-2 rounded-xl bg-background p-3 transition-colors duration-120 hover:bg-background/80',
        className,
      )}
    >
      <span className="text-sm tabular-nums">{label}</span>
      <Progress value={usedPercent} aria-label={label} />
      {children ? <span className="flex flex-col gap-1">{children}</span> : null}
    </UiLink>
  )
}
