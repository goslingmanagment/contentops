import { Skeleton } from '@contentops/ui/components/skeleton'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'

const ROWS = 9

/** Первая загрузка (DESIGN §3.10): заголовок группы 44 и строки 52 ровно их размера. */
export function ToPpvSkeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      <div className="flex h-11 items-end px-2 pb-2">
        <Skeleton className="h-4.5 w-40 rounded-sm" />
      </div>
      {Array.from({ length: ROWS }, (_, row) => (
        <ListRowSkeleton key={`row-${row}`} height={52} thumb="square" />
      ))}
    </div>
  )
}
