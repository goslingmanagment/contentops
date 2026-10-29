import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import type { ReactNode } from 'react'
import type { FileCover } from './file-thumb'

interface PreviewTileProps {
  cover: FileCover
  /** Ширина миниатюры 9:16: прежняя версия мастера 148, версия фупа 120. */
  width: number
  durationSeconds?: number
  /** Прежняя версия бледнее (DESIGN §4.5). */
  dimmed?: boolean
  title: ReactNode
  note: ReactNode
  onOpen: () => void
}

/**
 * То, что открывается в просмотре, но не выделяется как файл: прежняя версия мастера,
 * версия фупа для страницы. Вид — как у плитки файла, без галочки выбора. Подпись и
 * заметка переносятся на вторую строку, а не обрезаются: «версия 2 / подрезка».
 */
export function PreviewTile({
  cover,
  width,
  durationSeconds,
  dimmed = false,
  title,
  note,
  onOpen,
}: PreviewTileProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex select-none flex-col gap-1.5 rounded-xl p-1 text-left transition-colors duration-120 hover:bg-accent"
      style={{ width: width + 8 }}
    >
      <Thumb
        seed={cover.seed}
        kind={cover.kind}
        family={cover.family}
        frame={cover.frame}
        aspect="9:16"
        durationSeconds={durationSeconds}
        className={cn('transition-opacity duration-120', dimmed && 'opacity-55')}
      />
      <span className="flex min-w-0 flex-col px-0.5">
        <span className={cn('line-clamp-2 text-sm', dimmed && 'text-muted-foreground')}>
          {title}
        </span>
        <span className="line-clamp-2 text-ink-3 text-xs tabular-nums">{note}</span>
      </span>
    </button>
  )
}
