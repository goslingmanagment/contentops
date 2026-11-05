import {
  formatDuration,
  type InboxGroup,
  type ItemId,
  itemTypeOf,
  type ModelCode,
} from '@contentops/contracts'
import type { CoverKind } from '@contentops/ui/components/thumb'
import type { ViewerCompare, ViewerFile } from '@contentops/ui/components/viewer'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useApi } from '@/data/api-session'
import { useItem } from '@/data/object'
import { queryKeys } from '@/data/query-keys'
import { BUILDING_REFETCH_MS, isBuilding, toViewerFile } from '@/screens/object/viewer/viewer-files'
import type { SimilarHint } from '../panel/draft-panel'
import { groupKind, viewerFileOf } from '../shared/draft-cover'

export interface IntakePreview {
  title: string
  files: readonly ViewerFile[]
  index: number
  compare?: ViewerCompare
}

/** Что открыто: группа из списка и, у «Сравнить», файл объекта справа. */
interface OpenPreview {
  title: string
  group: InboxGroup
  index: number
  /** «Сравнить» у «Похоже на…»: новый файл слева и файл объекта справа. */
  compare?: { mine: string; item: ItemId; fileKey: string }
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
 * подсказки «Похоже на…» — две половины со шторкой. «Назад» и `Esc` закрывают. Превью файлов
 * отдаёт группа целиком — она читается при открытии; в списке их нет, он остаётся лёгким.
 */
export function useIntakePreview(model: ModelCode) {
  const api = useApi()
  const [open, setOpen] = useState<OpenPreview | null>(null)
  const groupId = open?.group.id
  const media = useQuery({
    queryKey: [...queryKeys.model(model), 'inbox-group-media', groupId],
    queryFn: ({ signal }) => api.inbox.get({ params: { model, group: groupId as string }, signal }),
    enabled: groupId !== undefined,
    refetchInterval: (query) => {
      const group = query.state.data
      const kind = group ? groupKind(group) : undefined
      return group && isBuilding(group.files.map((file) => viewerFileOf(file, kind)))
        ? BUILDING_REFETCH_MS
        : false
    },
  })
  const target = useItem(model, open?.compare?.item ?? '', { enabled: Boolean(open?.compare) })

  const preview = useMemo<IntakePreview | null>(() => {
    if (!open) {
      return null
    }
    const group = media.data?.id === open.group.id ? media.data : open.group
    const kind: CoverKind | undefined = groupKind(open.group)
    const files = group.files.map((file) => viewerFileOf(file, kind))
    if (!open.compare) {
      return { title: open.title, files, index: open.index }
    }
    const { mine, item, fileKey } = open.compare
    const leftDraft = group.files.find((file) => file.key === mine) ?? open.group.files[0]
    if (!leftDraft) {
      return null
    }
    const left = viewerFileOf(leftDraft, kind)
    const detail = target.data?.entry.id === item ? target.data : undefined
    const theirs = detail?.files.find((file) => file.key === fileKey)
    const right: ViewerFile =
      detail && theirs
        ? toViewerFile(detail.entry, theirs)
        : {
            seed: `${item}/${fileKey}`,
            type: leftDraft.media,
            aspect: leftDraft.thumb.ratio,
            kind: itemTypeOf(item),
          }
    return {
      title: open.title,
      files: [left],
      index: 0,
      compare: { left, right, leftLabel: 'Новое', rightLabel: item },
    }
  }, [open, media.data, target.data])

  const openGroup = useCallback((group: InboxGroup) => {
    if (group.files.length > 0) {
      setOpen({ title: group.title, group, index: 0 })
    }
  }, [])

  const openCompare = useCallback((group: InboxGroup, hint: SimilarHint) => {
    // «Похоже на ролик» говорит о своём файле группы; «Похоже на фото» — о первом фото.
    const mine =
      (hint.kind === 'similar_video'
        ? group.files.find((file) => file.key === hint.draft_key)
        : undefined) ??
      group.files.find((file) => file.media === 'photo') ??
      group.files[0]
    if (!mine) {
      return
    }
    setOpen({
      title: hint.text,
      group,
      index: 0,
      compare: { mine: mine.key, item: hint.item_id, fileKey: hint.file_key },
    })
  }, [])

  const setIndex = useCallback(
    (index: number) => setOpen((current) => (current ? { ...current, index } : current)),
    [],
  )
  const close = useCallback(() => setOpen(null), [])

  return { preview, openGroup, openCompare, setIndex, close }
}
