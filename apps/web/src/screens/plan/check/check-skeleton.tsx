import { Skeleton } from '@contentops/ui/components/skeleton'
import { cn } from '@contentops/ui/lib/utils'

/** Две группы по страницам: сколько строк в каждой, как у обычного дня сверки. */
const GROUPS = [
  { key: 'first', rows: 3 },
  { key: 'second', rows: 2 },
]

/** Строка 64 с миниатюрой 40 × 53, как у настоящего случая. */
function CaseRowSkeleton() {
  return (
    <div className="flex h-16 items-center gap-3 px-2">
      <Skeleton className="h-13.25 w-10 rounded-md" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-1/3 rounded-sm" />
        <Skeleton className="h-3 w-24 rounded-sm" />
      </div>
      <Skeleton className="h-3.5 w-32 rounded-sm" />
      <Skeleton className="ml-6 h-9 w-24 rounded-lg" />
    </div>
  )
}

/**
 * Первая загрузка «Сверить» (DESIGN §3.10): на месте групп и строк — серые заготовки ровно
 * их размера; шапка и чипы уже стоят, спиннера нет.
 */
export function CheckSkeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      {GROUPS.map((group, index) => (
        <div key={group.key} className="flex flex-col">
          <div className={cn('flex items-end px-2 pb-2', index === 0 ? 'h-10' : 'h-13')}>
            <Skeleton className="h-4 w-24 rounded-sm" />
          </div>
          {Array.from({ length: group.rows }, (_, row) => (
            <CaseRowSkeleton key={`${group.key}-${row}`} />
          ))}
        </div>
      ))}
    </div>
  )
}
