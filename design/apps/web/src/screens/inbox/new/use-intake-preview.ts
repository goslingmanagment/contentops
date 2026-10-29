import { formatDuration, type InboxGroup, itemTypeOf } from '@contentops/contracts'
import type { ViewerCompare, ViewerFile } from '@contentops/ui/components/viewer'
import { useCallback, useState } from 'react'
import type { SimilarHint } from '../panel/draft-panel'
import { groupKind, viewerFileOf } from '../shared/draft-cover'

export interface IntakePreview {
  title: string
  files: readonly ViewerFile[]
  index: number
  compare?: ViewerCompare
}

/** «2:54 грудь попа · мастер · 2:54» — как у объекта (§3.5): группа, роль файла, длительность. */
export function previewTitle(preview: IntakePreview): string {
  const file = preview.files[preview.index]
  if (preview.compare || !file) {
    return preview.title
  }
  const duration = file.durationSeconds === undefined ? null : formatDuration(file.durationSeconds)
  return [preview.title, file.label, duration].filter(Boolean).join(' · ')
}

/**
 * Просмотр из «Приехало» (DESIGN §3.5): `Space` открывает файлы группы, «Сравнить» у
 * подсказки «Похоже на…» — две половины со шторкой. «Назад» и `Esc` закрывают.
 */
export function useIntakePreview() {
  const [preview, setPreview] = useState<IntakePreview | null>(null)

  const openGroup = useCallback((group: InboxGroup) => {
    const kind = groupKind(group)
    if (group.files.length > 0) {
      setPreview({
        title: group.title,
        files: group.files.map((file) => viewerFileOf(file, kind)),
        index: 0,
      })
    }
  }, [])

  const openCompare = useCallback((group: InboxGroup, hint: SimilarHint) => {
    const kind = groupKind(group)
    const mine = group.files.find((file) => file.media === 'photo') ?? group.files[0]
    if (!mine) {
      return
    }
    const left = viewerFileOf(mine, kind)
    const right: ViewerFile = {
      seed: `${hint.item_id}/${hint.file_key}`,
      type: mine.media,
      aspect: mine.thumb.ratio,
      kind: itemTypeOf(hint.item_id),
    }
    setPreview({
      title: hint.text,
      files: [left],
      index: 0,
      compare: { left, right, leftLabel: 'Новое', rightLabel: hint.item_id },
    })
  }, [])

  const setIndex = useCallback(
    (index: number) => setPreview((current) => (current ? { ...current, index } : current)),
    [],
  )
  const close = useCallback(() => setPreview(null), [])

  return { preview, openGroup, openCompare, setIndex, close }
}
