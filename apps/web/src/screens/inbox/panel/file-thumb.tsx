import type { DraftFile } from '@contentops/contracts'
import type { CoverKind } from '@contentops/ui/components/thumb'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import type { ReactNode } from 'react'

interface FileThumbProps {
  file: DraftFile
  kind: CoverKind | undefined
  /** Чип роли, галочка — поверх миниатюры. */
  overlay?: ReactNode
  className?: string
}

/**
 * Файл черновика плиткой 72 × 96 (DESIGN §4.8): вертикальное видео вписано целиком, у
 * видео — длительность. Место держится заранее, миниатюра не прыгает.
 */
export function FileThumb({ file, kind, overlay, className }: FileThumbProps) {
  return (
    <Thumb
      seed={file.thumb.key}
      src={file.thumb.url}
      kind={kind}
      aspect="3:4"
      mediaAspect={file.thumb.ratio === '3:4' ? undefined : file.thumb.ratio}
      durationSeconds={file.duration_s ?? undefined}
      overlay={overlay}
      title={file.file_name}
      className={cn('w-18 shrink-0 rounded-lg', className)}
    />
  )
}
