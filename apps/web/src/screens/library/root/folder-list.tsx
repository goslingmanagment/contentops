import { formatNumber } from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useRef } from 'react'
import { useGridArrowFocus } from '@/lib/use-grid-arrow-focus'
import { useLibraryLinks } from '../shared/library-hrefs'
import { FolderNoteView } from './folder-note'
import type { LibraryFolder } from './library-folders'

/** Папки корня строками 52 (вид «Список»): обложка 40 × 40, название, состав, третья строка. */
export function FolderList({ folders }: { folders: readonly LibraryFolder[] }) {
  const links = useLibraryLinks()
  const listRef = useRef<HTMLUListElement>(null)
  const onKeyDown = useGridArrowFocus(listRef, 'a[data-folder-row]')
  return (
    <ul ref={listRef} aria-label="Разделы" onKeyDown={onKeyDown} className="-mx-2 flex flex-col">
      {folders.map((folder) => {
        const cover = folder.tiles[0]
        return (
          <li key={folder.key}>
            <UiLink
              href={links.folder(folder.key)}
              data-folder-row=""
              className="flex h-13 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent"
            >
              <span aria-hidden className="size-5 shrink-0" />
              {cover ? (
                <Thumb
                  seed={cover.seed}
                  kind={cover.kind}
                  family={cover.family}
                  aspect="1:1"
                  showCaptions={false}
                  className="w-10 shrink-0 rounded-md"
                />
              ) : (
                <span className="size-10 shrink-0 rounded-md bg-muted" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">
                  <span className="font-semibold">{folder.name}</span>
                  {folder.count === undefined ? null : (
                    <span className="ml-1.5 text-ink-3 text-sm tabular-nums">
                      {formatNumber(folder.count)}
                    </span>
                  )}
                </span>
                <span className="truncate text-muted-foreground text-sm">{folder.composition}</span>
              </span>
              <span className="flex w-64 shrink-0 justify-end truncate text-ink-3 text-sm">
                <FolderNoteView note={folder.note} />
              </span>
            </UiLink>
          </li>
        )
      })}
    </ul>
  )
}
