import { cn } from '@contentops/ui/lib/utils'
import type { ReactNode } from 'react'

interface FieldLayoutProps {
  /** Шапка, чипы и содержимое поля. */
  children: ReactNode
  /** Панель сведений: обычный блок справа, сужает содержимое, не всплывает поверх (§3.4). */
  aside?: ReactNode
  className?: string
}

/**
 * Раскладка внутри белого поля (DESIGN §3.1): поля 28 по бокам и 20 сверху, панель
 * сведений встаёт справа вплотную к краю поля.
 */
export function FieldLayout({ children, aside, className }: FieldLayoutProps) {
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col px-7 pt-5', className)}>
        {children}
      </div>
      {aside}
    </div>
  )
}
