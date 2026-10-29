import { FolderTile } from '@contentops/ui/components/folder-tile'
import { useRef } from 'react'
import { useGridArrowFocus } from '@/lib/use-grid-arrow-focus'
import { useLibraryLinks } from '../shared/library-hrefs'
import { FolderNoteView } from './folder-note'
import type { LibraryFolder } from './library-folders'

interface FolderGridProps {
  folders: readonly LibraryFolder[]
}

/**
 * Папки корня (DESIGN §4.1): резиновая сетка `minmax(200px, 1fr)`, промежуток 16.
 * Стрелки ходят по папкам, `Enter` открывает раздел.
 */
export function FolderGrid({ folders }: FolderGridProps) {
  const links = useLibraryLinks()
  const gridRef = useRef<HTMLUListElement>(null)
  const onKeyDown = useGridArrowFocus(gridRef, '[data-folder-link]')
  return (
    <ul
      ref={gridRef}
      aria-label="Разделы"
      onKeyDown={onKeyDown}
      className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"
    >
      {folders.map((folder) => (
        <li key={folder.key} className="min-w-0">
          <FolderTile
            href={links.folder(folder.key)}
            name={folder.name}
            count={folder.count}
            composition={folder.composition}
            note={<FolderNoteView note={folder.note} />}
            noteHref={folder.note?.kind === 'overdue' ? links.orders() : undefined}
            tiles={folder.tiles}
            layout={folder.layout}
          />
        </li>
      ))}
    </ul>
  )
}
