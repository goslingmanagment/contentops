import { FolderTileSkeleton } from '@contentops/ui/components/skeletons'

const FOLDERS = 5

/** Первая загрузка канала (DESIGN §3.10): папки подборок ровно их размера. */
export function ChannelSkeleton() {
  return (
    <div aria-hidden className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      {Array.from({ length: FOLDERS }, (_, index) => (
        <FolderTileSkeleton key={`folder-${index}`} />
      ))}
    </div>
  )
}
