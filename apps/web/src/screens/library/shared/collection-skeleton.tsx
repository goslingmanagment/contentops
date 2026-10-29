import type { ObjectTileView } from '@contentops/ui/components/object-tile'
import { ObjectTileSkeleton } from '@contentops/ui/components/skeletons'
import { cn } from '@contentops/ui/lib/utils'
import { TILE_MIN_WIDTH } from './collection-layout'

const COUNT: Record<ObjectTileView, number> = { large: 10, tile: 24, row: 12 }

/**
 * Первая загрузка списка (DESIGN §3.10): заготовки ровно размера будущих плиток в той же
 * резиновой сетке, спиннера нет.
 */
export function CollectionSkeleton({
  view,
  className,
}: {
  view: ObjectTileView
  className?: string
}) {
  return (
    <div
      aria-busy
      className={cn(view === 'row' ? 'flex flex-col' : 'grid gap-4', className)}
      style={
        view === 'row'
          ? undefined
          : { gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_WIDTH[view]}px, 1fr))` }
      }
    >
      {Array.from({ length: COUNT[view] }, (_, index) => (
        <ObjectTileSkeleton key={index} view={view} />
      ))}
    </div>
  )
}
