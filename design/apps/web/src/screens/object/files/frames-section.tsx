import { formatDuration, type MasterFrame } from '@contentops/contracts'
import { useObjectPage } from '../object-context'
import { FileGrid } from './file-grid'
import { frameKey } from './file-keys'
import { useFileSelection } from './file-selection'
import { frameCover } from './file-thumb'
import { FileTile } from './file-tile'
import { FilesSection } from './files-section'
import { PendingRing } from './pending-operations'

const FRAME_WIDTH = 82

interface IndexedFrame extends MasterFrame {
  key: string
}

/**
 * «Кадры мастера»: до десяти кадров сеткой 5 × 2 (82 × 146) с таймкодом (DESIGN §4.5).
 * Двойной клик и `Enter` открывают просмотр мастера на таймкоде кадра; выделенные кадры
 * становятся фото или обложкой из полосы выделения.
 */
export function FramesSection() {
  const { detail, openFile } = useObjectPage()
  const selection = useFileSelection()
  const frames: IndexedFrame[] = detail.frames.map((frame, index) => ({
    ...frame,
    key: frameKey(index),
  }))
  if (frames.length === 0) {
    return null
  }
  return (
    <FilesSection title="Кадры мастера" count={frames.length}>
      <FileGrid
        items={frames}
        getKey={(frame) => frame.key}
        label="Кадры мастера"
        cellWidth={FRAME_WIDTH + 8}
        fixedColumns={5}
        onOpen={(frame) => openFile('master', { seconds: frame.t_s })}
        renderItem={(frame, state) => (
          <FileTile
            cover={frameCover(detail.entry, frame)}
            label={`кадр ${formatDuration(frame.t_s)}`}
            width={FRAME_WIDTH}
            aspect="9:16"
            selected={state.selected}
            onSelectedChange={(on) => selection.toggle(frame.key, on)}
            pending={<PendingRing fileKey={frame.key} />}
            caption={
              <span className="text-ink-3 text-xs tabular-nums">{formatDuration(frame.t_s)}</span>
            }
          />
        )}
      />
    </FilesSection>
  )
}
