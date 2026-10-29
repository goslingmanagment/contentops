import { ObjectTileSkeleton } from '@contentops/ui/components/skeletons'

const TILES = 14

/** Первая загрузка подборки (DESIGN §3.10): заготовки плиток 3:4 ровно их размера. */
export function CollectionSkeleton() {
  return (
    <div
      aria-hidden
      className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2 overflow-hidden"
    >
      {Array.from({ length: TILES }, (_, index) => (
        <ObjectTileSkeleton key={`tile-${index}`} view="tile" />
      ))}
    </div>
  )
}
