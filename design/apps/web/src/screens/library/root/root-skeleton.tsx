import { Skeleton } from '@contentops/ui/components/skeleton'
import { FolderTileSkeleton, ObjectTileSkeleton } from '@contentops/ui/components/skeletons'

const FOLDER_COUNT = 9
const RECENT_COUNT = 8

/**
 * Первая загрузка корня (DESIGN §3.10): заготовки ровно размера папок и плиток
 * «Недавних», спиннера нет.
 */
export function RootSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-busy>
      <div className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
        {Array.from({ length: FOLDER_COUNT }, (_, index) => (
          <FolderTileSkeleton key={index} />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20 rounded-sm" />
        <div className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4">
          {Array.from({ length: RECENT_COUNT }, (_, index) => (
            <ObjectTileSkeleton key={index} view="tile" />
          ))}
        </div>
      </div>
    </div>
  )
}
