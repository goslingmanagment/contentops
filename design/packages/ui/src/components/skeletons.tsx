import { cn } from 'cn'
import type { ObjectTileView } from './object-tile'
import { Skeleton } from './skeleton'

/**
 * Заготовки первой загрузки (DESIGN §3.10): ровно размера будущих плиток и строк,
 * спиннера на весь экран нет.
 */
export function FolderTileSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('flex flex-col gap-2.5 p-2', className)}>
      <div className="pt-2.5">
        <Skeleton className="aspect-[211/132] rounded-2xl" />
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <Skeleton className="h-4 w-20 rounded-sm" />
        <Skeleton className="h-3.5 w-32 rounded-sm" />
        <span className="h-3.5" />
      </div>
    </div>
  )
}

export function ObjectTileSkeleton({
  view,
  className,
}: {
  view: ObjectTileView
  className?: string
}) {
  if (view === 'row') {
    return <ListRowSkeleton height={52} thumb="square" className={className} />
  }
  return (
    <div aria-hidden className={cn('flex flex-col gap-2 p-2', className)}>
      <Skeleton className="aspect-[3/4]" />
      <div className="flex flex-col gap-1.5 px-0.5">
        <Skeleton className="h-3.5 w-4/5 rounded-sm" />
        <Skeleton className="h-3.5 w-1/2 rounded-sm" />
        <Skeleton className="h-3 w-16 rounded-sm" />
      </div>
    </div>
  )
}

const rowHeightClass = {
  44: 'h-11',
  48: 'h-12',
  52: 'h-13',
  54: 'h-13.5',
  64: 'h-16',
} as const

interface ListRowSkeletonProps {
  /** Строка списка 52, плана 54, «Приехало», сверки и заказа 64, журнала 48, мини-строка 44. */
  height: keyof typeof rowHeightClass
  thumb?: 'square' | 'portrait' | 'none'
  className?: string
}

export function ListRowSkeleton({ height, thumb = 'portrait', className }: ListRowSkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn('flex items-center gap-3 px-2', rowHeightClass[height], className)}
    >
      {thumb === 'square' ? <Skeleton className="size-10 rounded-md" /> : null}
      {thumb === 'portrait' ? <Skeleton className="h-10 w-7.5 rounded-md" /> : null}
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-1/3 rounded-sm" />
        <Skeleton className="h-3 w-24 rounded-sm" />
      </div>
      <Skeleton className="h-3.5 w-20 rounded-sm" />
    </div>
  )
}
