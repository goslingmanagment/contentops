import type { ItemFile } from '@contentops/contracts'
import { UiLink } from '@contentops/ui/components/ui-link'
import { VirtualGrid } from '@contentops/ui/components/virtual-grid'
import { useHref } from '@/app/use-href'
import { useHistoryScroll } from '@/lib/use-history-state'
import { useObjectPage } from '../../object-context'
import { useFileSelection } from '../file-selection'
import { fileCover } from '../file-thumb'
import { FileTile } from '../file-tile'
import { FilesSection } from '../files-section'
import { PHOTO_WIDTH } from '../photos-section'

const CELL = PHOTO_WIDTH + 8
/** Миниатюра 3:4, подпись с ID источника и поля плитки. */
const ROW_HEIGHT = Math.round((PHOTO_WIDTH * 4) / 3) + 8 + 26

/**
 * Промо-подборка (DESIGN §4.5): файлы-ссылки, под каждой плиткой — ID исходного объекта.
 * В подборке бывает 60–600 материалов, поэтому сетка виртуальная (§3.13).
 */
export function PromoFiles() {
  const { detail, openFile } = useObjectPage()
  const selection = useFileSelection()
  const scroll = useHistoryScroll(`object:${detail.entry.id}:scroll`)
  return (
    <FilesSection title="Материалы" count={detail.files.length} className="min-h-0 flex-1 pt-1">
      <VirtualGrid
        items={detail.files}
        getKey={(file) => file.key}
        label="Материалы"
        minColumnWidth={CELL}
        getRowHeight={() => ROW_HEIGHT}
        gap={8}
        selectedKeys={selection.keys}
        onSelectedKeysChange={selection.setKeys}
        onOpen={(file) => openFile(file.key)}
        initialScrollOffset={scroll.initialOffset}
        onScrollOffsetChange={scroll.onScrollOffsetChange}
        className="-mx-1 min-h-0 flex-1 pb-6"
        renderItem={(file, state) => (
          <FileTile
            cover={fileCover(detail.entry, file)}
            label={file.label}
            width={PHOTO_WIDTH}
            aspect="3:4"
            mediaAspect={file.width > file.height ? '16:9' : '9:16'}
            selected={state.selected}
            onSelectedChange={(on) => selection.toggle(file.key, on)}
            caption={<SourceLink file={file} />}
          />
        )}
      />
    </FilesSection>
  )
}

function SourceLink({ file }: { file: ItemFile }) {
  const { model } = useObjectPage()
  const href = useHref()
  if (!file.source) {
    return null
  }
  return (
    <UiLink
      href={href({ to: '/$model/i/$id', params: { model: model.code, id: file.source.item_id } })}
      onClick={(event) => event.stopPropagation()}
      className="w-fit text-primary-ink text-xs tabular-nums hover:underline"
    >
      {file.source.item_id}
    </UiLink>
  )
}
