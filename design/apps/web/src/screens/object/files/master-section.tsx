import { formatDate, type ItemFile, type LocalDate } from '@contentops/contracts'
import { useToday } from '@/data/api-session'
import { useUploads } from '@/shell/upload/upload-context'
import { useObjectPage } from '../object-context'
import { FileGrid } from './file-grid'
import { useFileMenu } from './file-menu'
import { useFileSelection } from './file-selection'
import { fileCover, versionCover } from './file-thumb'
import { FileTile } from './file-tile'
import { FilesSection, MissingFile } from './files-section'
import { PendingRing } from './pending-operations'
import { PreviewTile } from './preview-tile'

const MASTER_WIDTH = 148

interface MasterSectionProps {
  /** «Мастер и тизер» у PPV, «Мастер» у кастома. */
  title: string
  /** PPV без тизера: пунктирное место «Тизера нет · перетащите сюда». */
  teaserSlot?: boolean
  /** Кастом: прежние версии мастера рядом, бледнее, с подписью «v1 · до правки 20.09». */
  showVersions?: boolean
}

/** «v2 · перемонтаж 12.08»: версия под мастером, если их больше одной. */
function versionNote(file: ItemFile, today: LocalDate): string | null {
  const current = file.versions.find((version) => version.no === file.current_version)
  if (!current || file.versions.length < 2) {
    return null
  }
  return [`v${current.no}`, current.reason, formatDate(current.on, today)]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Мастер 148 × 263 (9:16) со стопкой версий и тизер рядом (DESIGN §4.5). Пока мастер
 * сжимается, на плитке — «сжимается 62 %»; загруженный тизер «проверяется» на своей плитке.
 */
export function MasterSection({
  title,
  teaserSlot = false,
  showVersions = false,
}: MasterSectionProps) {
  const today = useToday()
  const { detail, canAct, openFile } = useObjectPage()
  const selection = useFileSelection()
  const menuFor = useFileMenu()
  const { openUploadDialog } = useUploads()
  const master = detail.files.find((file) => file.role === 'master')
  const teaser = detail.files.find((file) => file.role === 'teaser')
  const tiles = [master, teaser].filter((file): file is ItemFile => file !== undefined)
  const versions = master?.versions ?? []
  const older = showVersions
    ? versions
        .filter((version) => version.no !== master?.current_version)
        .map((version) => ({
          ...version,
          fixedOn: versions.find((next) => next.no === version.no + 1)?.on ?? version.on,
        }))
        .reverse()
    : []

  return (
    <FilesSection title={title}>
      <div className="flex flex-wrap items-start gap-2">
        <FileGrid
          items={tiles}
          getKey={(file) => file.key}
          label={title}
          cellWidth={MASTER_WIDTH + 8}
          fixedColumns={tiles.length}
          onOpen={(file) => openFile(file.key)}
          menuFor={menuFor}
          renderItem={(file, state) => (
            <FileTile
              cover={fileCover(detail.entry, file)}
              label={file.label}
              width={MASTER_WIDTH}
              aspect="9:16"
              selected={state.selected}
              onSelectedChange={(on) => selection.toggle(file.key, on)}
              durationSeconds={file.duration_s ?? undefined}
              state={file.state}
              stacked={file.versions.length > 1}
              versionCount={file.versions.length}
              pending={<PendingRing fileKey={file.key} />}
              caption={
                <>
                  <span className="text-sm first-letter:uppercase">{file.label}</span>
                  <span className="truncate text-ink-3 text-xs tabular-nums">
                    {versionNote(file, today) ?? ' '}
                  </span>
                </>
              }
            />
          )}
        />
        {older.map((version) => (
          <PreviewTile
            key={version.no}
            cover={versionCover(detail.entry, version.no, master?.current_version ?? 1)}
            width={MASTER_WIDTH}
            durationSeconds={version.duration_s ?? undefined}
            dimmed
            title={`Мастер v${version.no}`}
            note={`до правки ${formatDate(version.fixedOn, today)}`}
            onOpen={() => openFile('master', { version: version.no })}
          />
        ))}
        {teaserSlot && !teaser ? (
          <MissingFile
            width={MASTER_WIDTH}
            aspect="9:16"
            onDropFiles={canAct ? (files) => openUploadDialog(files) : undefined}
          >
            Тизера нет · перетащите сюда
          </MissingFile>
        ) : null}
      </div>
    </FilesSection>
  )
}
