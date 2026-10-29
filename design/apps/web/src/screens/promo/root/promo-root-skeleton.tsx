import { FolderTileSkeleton, ListRowSkeleton } from '@contentops/ui/components/skeletons'

const FOLDERS = 6
const ROWS = 8

/** Первая загрузка (DESIGN §3.10): папки каналов или строки передач ровно их размера. */
export function PromoRootSkeleton({ view }: { view: 'channels' | 'handoffs' }) {
  if (view === 'handoffs') {
    return (
      <div aria-hidden className="flex flex-col">
        {Array.from({ length: ROWS }, (_, row) => (
          <ListRowSkeleton key={`row-${row}`} height={52} thumb="square" />
        ))}
      </div>
    )
  }
  return (
    <div aria-hidden className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      {Array.from({ length: FOLDERS }, (_, index) => (
        <FolderTileSkeleton key={`folder-${index}`} />
      ))}
    </div>
  )
}
