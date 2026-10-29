import { Skeleton } from '@contentops/ui/components/skeleton'
import type { CSSProperties } from 'react'

const DAYS = 7

/** Первая загрузка недели: заготовки шапок столбцов 56 и ячеек с мини-строками 44. */
export function WeekSkeleton({ pages }: { pages: number }) {
  const style = { '--pages': pages } as CSSProperties
  return (
    <div
      aria-hidden
      style={style}
      className="grid grid-cols-[4rem_repeat(var(--pages),minmax(0,1fr))]"
    >
      <div className="h-14" />
      {Array.from({ length: pages }, (_, page) => (
        <div key={`head-${page}`} className="flex h-14 flex-col justify-center gap-1.5 px-2.5">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <Skeleton className="h-3 w-12 rounded-sm" />
        </div>
      ))}
      {Array.from({ length: DAYS }, (_, day) => (
        <div key={`day-${day}`} className="contents">
          <div className="border-border border-t px-2 py-2.5">
            <Skeleton className="h-5 w-6 rounded-sm" />
          </div>
          {Array.from({ length: pages }, (_, page) => (
            <div
              key={`cell-${day}-${page}`}
              className="flex flex-col gap-1 border-border border-t border-l p-1.5"
            >
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
