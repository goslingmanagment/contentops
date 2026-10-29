import { Skeleton } from '@contentops/ui/components/skeleton'
import { FieldLayout } from './field-layout'

/**
 * Поле, пока не пришёл список моделей (DESIGN §3.10): шапка на своём месте с заготовками
 * крошек, заголовка и управления, а не белое поле. Экран встаёт на то же место со своими
 * заготовками строк и плиток.
 */
export function FieldSkeleton() {
  return (
    <FieldLayout>
      <div aria-hidden className="flex h-18 shrink-0 items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-24 rounded-sm" />
          <Skeleton className="h-5 w-40 rounded-sm" />
        </div>
        <Skeleton className="h-9 w-28" />
        <Skeleton className="size-9" />
      </div>
      <div aria-hidden className="flex h-11 shrink-0 items-center gap-2">
        <Skeleton className="h-8 w-28 rounded-2xl" />
        <Skeleton className="h-8 w-24 rounded-2xl" />
        <Skeleton className="h-8 w-20 rounded-2xl" />
      </div>
    </FieldLayout>
  )
}
