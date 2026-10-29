import { type DraftFile, formatNumber, plural } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronRightIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'

interface ArchiveFolder {
  name: string
  files: DraftFile[]
}

/** Папки внутри архива — по началу пути файла: `Сеты 03.07/IMG_0001.JPG`. */
export function archiveFoldersOf(files: readonly DraftFile[]): ArchiveFolder[] {
  const folders = new Map<string, DraftFile[]>()
  for (const file of files) {
    const slash = file.file_name.indexOf('/')
    const name = slash > 0 ? file.file_name.slice(0, slash) : 'Без папки'
    folders.set(name, [...(folders.get(name) ?? []), file])
  }
  return [...folders].map(([name, inFolder]) => ({ name, files: inFolder }))
}

/** «70 фото и 4 видео». */
export function compositionOf(files: readonly DraftFile[]): string {
  const photos = files.filter((file) => file.media === 'photo').length
  const videos = files.length - photos
  const parts = [
    photos > 0 ? `${formatNumber(photos)} фото` : null,
    videos > 0 ? `${formatNumber(videos)} ${plural(videos, ['видео', 'видео', 'видео'])}` : null,
  ].filter((part) => part !== null)
  return parts.join(' и ')
}

interface ArchiveContentsProps {
  files: readonly DraftFile[]
  pending: boolean
  onSplit: (keys: readonly string[]) => void
  renderFiles: (files: readonly DraftFile[]) => ReactNode
}

/**
 * Архив с оглавлением (DESIGN §2.5, §4.8): папки внутри раскрываются, как папки; каждую
 * можно выделить в свою группу и принять отдельно.
 */
export function ArchiveContents({ files, pending, onSplit, renderFiles }: ArchiveContentsProps) {
  const [open, setOpen] = useState<string | null>(null)
  const folders = archiveFoldersOf(files)
  return (
    <ul className="-mx-2 flex flex-col">
      {folders.map((folder) => {
        const expanded = open === folder.name
        return (
          <li key={folder.name} className="flex flex-col">
            <div className="flex h-11 items-center gap-2 rounded-lg px-2 hover:bg-accent">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : folder.name)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    'size-4 shrink-0 text-ink-3 transition-transform duration-120',
                    expanded && 'rotate-90',
                  )}
                />
                <span className="truncate">{folder.name}</span>
                <span className="shrink-0 text-ink-3 text-sm">{compositionOf(folder.files)}</span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => onSplit(folder.files.map((file) => file.key))}
              >
                Выделить в новую
              </Button>
            </div>
            {expanded ? <div className="px-2 pt-1 pb-3">{renderFiles(folder.files)}</div> : null}
          </li>
        )
      })}
    </ul>
  )
}
