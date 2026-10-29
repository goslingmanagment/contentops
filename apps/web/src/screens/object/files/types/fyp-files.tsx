import {
  type FypVersion,
  formatDate,
  type ItemFile,
  type LocalDate,
  UNIQ_LEVEL_LABEL,
} from '@contentops/contracts'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useHref } from '@/app/use-href'
import { useToday } from '@/data/api-session'
import { useObjectPage } from '../../object-context'
import { FileGrid } from '../file-grid'
import { fypVersionKey } from '../file-keys'
import { useFileMenu } from '../file-menu'
import { useFileSelection } from '../file-selection'
import { fileCover, versionTileCover } from '../file-thumb'
import { FileTile } from '../file-tile'
import { FilesScroll } from '../files-scroll'
import { FilesSection } from '../files-section'
import { FypVersionsPopover } from '../fyp-versions-popover'
import { PendingRing, usePendingOperations } from '../pending-operations'
import { PreviewTile } from '../preview-tile'

const MONTAGE_WIDTH = 148
const VERSION_WIDTH = 120

/**
 * Фуп (DESIGN §4.5): «Монтаж» 9:16, «Исходник» со ссылкой на сырьё и «Версии» для
 * страниц — «версия 1 · мягко» и где она стоит. Версию можно открыть до заливки.
 */
export function FypFiles() {
  const { detail } = useObjectPage()
  const montage = detail.files.filter((file) => file.role === 'montage')
  const source = detail.files.filter((file) => file.role === 'source')
  return (
    <FilesScroll>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-6">
        <RoleTiles title="Монтаж" files={montage} />
        {source.length > 0 ? <RoleTiles title="Исходник" files={source} /> : null}
        <VersionsSection />
      </div>
    </FilesScroll>
  )
}

function RoleTiles({ title, files }: { title: string; files: ItemFile[] }) {
  const { detail, openFile } = useObjectPage()
  const selection = useFileSelection()
  const menuFor = useFileMenu()
  return (
    <FilesSection title={title}>
      <FileGrid
        items={files}
        getKey={(file) => file.key}
        label={title}
        cellWidth={MONTAGE_WIDTH + 8}
        fixedColumns={files.length}
        onOpen={(file) => openFile(file.key)}
        menuFor={menuFor}
        renderItem={(file, state) => (
          <FileTile
            cover={fileCover(detail.entry, file)}
            label={file.label}
            width={MONTAGE_WIDTH}
            aspect="9:16"
            selected={state.selected}
            onSelectedChange={(on) => selection.toggle(file.key, on)}
            durationSeconds={file.duration_s ?? undefined}
            state={file.state}
            caption={<SourceCaption file={file} />}
          />
        )}
      />
    </FilesSection>
  )
}

/** Под исходником — объект сырья ссылкой и имя файла съёмки. */
function SourceCaption({ file }: { file: ItemFile }) {
  const { model } = useObjectPage()
  const href = useHref()
  if (!file.source) {
    return <span className="truncate text-ink-3 text-xs">{file.file_name}</span>
  }
  return (
    <span className="flex min-w-0 flex-col text-xs">
      <UiLink
        href={href({ to: '/$model/i/$id', params: { model: model.code, id: file.source.item_id } })}
        onClick={(event) => event.stopPropagation()}
        className="w-fit text-primary-ink tabular-nums hover:underline"
      >
        {file.source.item_id}
      </UiLink>
      <span className="truncate font-mono text-ink-3">{file.file_name}</span>
    </span>
  )
}

function placedText(
  version: FypVersion,
  labelOf: (code: string) => string,
  today: LocalDate,
): string {
  if (version.placed.length === 0) {
    return 'ещё не было'
  }
  return version.placed
    .map((placed) =>
      placed.on
        ? `${labelOf(placed.account)} · ${formatDate(placed.on, today)}`
        : labelOf(placed.account),
    )
    .join(', ')
}

function VersionsSection() {
  const today = useToday()
  const { detail, model, canAct, openFile } = useObjectPage()
  const { operations } = usePendingOperations()
  const building = operations.find((operation) => operation.keys.includes('versions'))
  const labelOf = (code: string) =>
    model.accounts.find((account) => account.code === code)?.label ?? code
  const versions = detail.fyp_versions

  return (
    <FilesSection
      title="Версии"
      count={versions.length > 0 ? versions.length : undefined}
      action={canAct ? <FypVersionsPopover /> : undefined}
    >
      {versions.length === 0 && !building ? (
        <p className="text-muted-foreground">Версий для страниц ещё нет</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {versions.map((version) => (
            <li key={version.no}>
              <PreviewTile
                cover={versionTileCover(detail.entry, version)}
                width={VERSION_WIDTH}
                durationSeconds={version.duration_s}
                title={
                  <>
                    <span className="block">версия {version.no}</span>
                    <span className="block text-muted-foreground">
                      {UNIQ_LEVEL_LABEL[version.level]}
                    </span>
                  </>
                }
                note={placedText(version, labelOf, today)}
                onOpen={() => openFile(fypVersionKey(version.no))}
              />
            </li>
          ))}
          {building ? (
            <li
              className="relative m-1 overflow-hidden rounded-lg bg-muted"
              style={{ width: VERSION_WIDTH, aspectRatio: '9 / 16' }}
            >
              <PendingRing fileKey="versions" />
            </li>
          ) : null}
        </ul>
      )}
    </FilesSection>
  )
}
