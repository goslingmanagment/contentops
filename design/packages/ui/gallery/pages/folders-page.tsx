import { FolderTile } from '../../src/components/folder-tile'
import { GallerySection } from '../gallery-section'
import { libraryFolders } from '../sample-folders'

export function FoldersPage() {
  return (
    <GallerySection
      title="Папки корня Библиотеки"
      note="DESIGN §4.1: мозаика, число, состав, третья строка"
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
        {libraryFolders.map((folder) => (
          <FolderTile key={folder.href} {...folder} />
        ))}
      </div>
    </GallerySection>
  )
}
