import {
  formatClock,
  type ItemFile,
  mskTime,
  RAW_PURPOSE_LABEL,
  type RawPurpose,
  RawPurposeSchema,
} from '@contentops/contracts'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { useObjectPage } from '../../object-context'
import { FilesScroll } from '../files-scroll'
import { byPosition } from '../ordered-files'
import { PhotosSection } from '../photos-section'
import { useSetRawPurpose } from '../use-file-commands'

interface ShotGroup {
  label: string
  files: ItemFile[]
}

/** Файлы по времени съёмки часами: «14:02–14:58», «15:00–15:12» (DESIGN §4.5). */
function groupByHour(files: readonly ItemFile[]): ShotGroup[] {
  const groups = new Map<string, ItemFile[]>()
  for (const file of files) {
    const hour = file.shot_at ? mskTime(file.shot_at).slice(0, 2) : '—'
    groups.set(hour, [...(groups.get(hour) ?? []), file])
  }
  return [...groups.values()].map((group) => {
    const first = group[0]?.shot_at
    const last = group.at(-1)?.shot_at
    const label =
      first && last
        ? first === last
          ? formatClock(first)
          : `${formatClock(first)}–${formatClock(last)}`
        : 'Время съёмки неизвестно'
    return { label, files: group }
  })
}

/**
 * Сырьё («съёмка 34», DESIGN §4.5): назначение чипами, файлы по времени съёмки с
 * подписями часов. Выделенное видео — «Сделать мастером PPV», выделенные файлы —
 * «Выделить в новую съёмку» в полосе выделения.
 */
export function RawFiles() {
  const { detail, canAct } = useObjectPage()
  const setPurpose = useSetRawPurpose()
  const groups = groupByHour(byPosition(detail.files))
  const purpose = detail.entry.raw_purpose

  return (
    <FilesScroll>
      <div className="flex items-center gap-3">
        <span className="text-ink-3 text-sm">Назначение</span>
        {canAct ? (
          <ChoiceChips<RawPurpose>
            label="Назначение"
            choices={RawPurposeSchema.options.map((option) => ({
              value: option,
              label: RAW_PURPOSE_LABEL[option],
            }))}
            value={purpose}
            onChange={(next) => next !== purpose && setPurpose(next)}
          />
        ) : (
          <span className="text-sm">{purpose ? RAW_PURPOSE_LABEL[purpose] : 'неизвестно'}</span>
        )}
      </div>
      {groups.map((group) => (
        <PhotosSection key={group.label} title={group.label} files={group.files} />
      ))}
    </FilesScroll>
  )
}
