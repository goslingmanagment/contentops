import { Skeleton } from '@contentops/ui/components/skeleton'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'

const GROUPS = [3, 3, 2] as const

/**
 * Первая загрузка дня (DESIGN §3.10): заготовки ровно размера заголовков групп 48 и строк
 * 54, без спиннера.
 */
export function DaySkeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      {GROUPS.map((rows, group) => (
        <div key={group}>
          <div className="flex h-12 items-end px-2 pb-2">
            <Skeleton className="h-4 w-40 rounded-sm" />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            <ListRowSkeleton key={row} height={54} />
          ))}
        </div>
      ))}
    </div>
  )
}
