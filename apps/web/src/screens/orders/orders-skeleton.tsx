import { Skeleton } from '@contentops/ui/components/skeleton'

const GROUPS = [3, 2] as const

/** Первая загрузка заказов (DESIGN §3.10): заголовки групп 44 и строки 64 ровно их размера. */
export function OrdersSkeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      {GROUPS.map((rows, group) => (
        <div key={`group-${rows}-${group}`} className="flex flex-col">
          <div className="flex h-11 items-end px-2 pb-2">
            <Skeleton className="h-4.5 w-36 rounded-sm" />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            <div key={`row-${group}-${row}`} className="flex h-16 items-center gap-3 px-2">
              <Skeleton className="aspect-[3/4] w-10 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-56 rounded-sm" />
                <Skeleton className="h-3.5 w-72 rounded-sm" />
              </div>
              <Skeleton className="h-3.5 w-14 rounded-sm" />
              <Skeleton className="h-3.5 w-44 rounded-sm" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
