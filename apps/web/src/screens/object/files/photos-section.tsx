import type { ItemFile } from '@contentops/contracts'
import type { ReactNode } from 'react'
import { useObjectPage } from '../object-context'
import { FileGrid, type GridKeyAction } from './file-grid'
import { useFileMenu } from './file-menu'
import { useFileSelection } from './file-selection'
import { fileCover } from './file-thumb'
import { FileTile } from './file-tile'
import { FilesSection } from './files-section'
import { PendingRing } from './pending-operations'
import { useReorderFiles } from './use-file-commands'

export const PHOTO_WIDTH = 98

interface PhotosSectionProps {
  title: string
  /** Файлы уже в нужном порядке. */
  files: readonly ItemFile[]
  count?: number
  /** «в порядке для заливки». */
  note?: string
  action?: ReactNode
  /** Номер на плитке — позиция в порядке для заливки (под фильтром — прежняя позиция). */
  numbered?: boolean
  /** Порядок перетаскиванием (dnd-kit); у «только чтения» его нет. */
  sortable?: boolean
  marks?: (file: ItemFile) => ReactNode
  corner?: (file: ItemFile) => ReactNode
  /** Прежняя, бледная плитка: кадр сета, который не отобран. */
  dimmed?: (file: ItemFile) => boolean
  onKeyAction?: GridKeyAction
  /** Пусто: одна строка о том, что делать. */
  empty?: ReactNode
}

/**
 * Фото и файлы объекта плитками 98 × 131 (DESIGN §7.6): номера, метки, галочка выбора.
 * Порядок меняется перетаскиванием — плитка поднимается с тенью, соседи расступаются.
 */
export function PhotosSection({
  title,
  files,
  count,
  note,
  action,
  numbered = false,
  sortable = false,
  marks,
  corner,
  dimmed,
  onKeyAction,
  empty,
}: PhotosSectionProps) {
  const { detail, canAct, openFile } = useObjectPage()
  const selection = useFileSelection()
  const menuFor = useFileMenu()
  const reorder = useReorderFiles()
  const keys = files.map((file) => file.key)

  return (
    <FilesSection
      title={title}
      count={(count ?? files.length) > 0 ? (count ?? files.length) : undefined}
      note={note}
      action={action}
    >
      {files.length === 0 && empty ? (
        empty
      ) : (
        <FileGrid
          items={files}
          getKey={(file) => file.key}
          label={title}
          cellWidth={PHOTO_WIDTH + 8}
          onOpen={(file) => openFile(file.key)}
          onKeyAction={onKeyAction}
          onReorder={sortable && canAct ? (next) => reorder(next, keys) : undefined}
          menuFor={menuFor}
          renderItem={(file, state) => (
            <FileTile
              cover={fileCover(detail.entry, file)}
              label={file.label}
              width={PHOTO_WIDTH}
              aspect="3:4"
              mediaAspect={file.width > file.height ? '16:9' : undefined}
              selected={state.selected}
              onSelectedChange={(on) => selection.toggle(file.key, on)}
              number={numbered ? (file.position ?? state.index + 1) : undefined}
              durationSeconds={file.duration_s ?? undefined}
              marks={marks?.(file)}
              corner={corner?.(file)}
              state={file.state}
              dimmed={dimmed?.(file) ?? false}
              pending={<PendingRing fileKey={file.key} />}
            />
          )}
        />
      )}
    </FilesSection>
  )
}
