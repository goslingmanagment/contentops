import { Skeleton } from '@contentops/ui/components/skeleton'
import { FolderTileSkeleton, ListRowSkeleton } from '@contentops/ui/components/skeletons'
import type { InboxView } from '../search'

const TILES = [0, 1, 2, 3, 4, 5] as const

/** Первая загрузка «Нового» (DESIGN §3.10): заготовки ровно размера плиток и строк. */
export function IntakeSkeleton({ view }: { view: InboxView }) {
  return (
    <div aria-hidden className="flex flex-col gap-2 pt-3">
      <Skeleton className="h-5 w-40 rounded-sm" />
      {view === 'large' ? (
        <div className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-4 gap-y-2">
          {TILES.map((tile) => (
            <FolderTileSkeleton key={tile} />
          ))}
        </div>
      ) : (
        <div className="-mx-2 flex flex-col gap-0.5">
          {TILES.map((tile) => (
            <ListRowSkeleton key={tile} height={64} />
          ))}
        </div>
      )}
    </div>
  )
}
