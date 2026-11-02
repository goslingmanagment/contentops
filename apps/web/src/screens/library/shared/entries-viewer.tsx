import {
  type CatalogEntry,
  formatDuration,
  type ItemDetail,
  type ItemId,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Viewer, type ViewerFile } from '@contentops/ui/components/viewer'
import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useItem } from '@/data/object'
import { itemCover } from '@/lib/item-cover'
import { metaLine } from '@/objects/item-facts'
import { BUILDING_REFETCH_MS, isBuilding, toViewerFile } from '@/screens/object/viewer/viewer-files'
import { useCurrentModel } from '@/shell/model/model-context'

/**
 * Объект в просмотре из сетки: мастер у видео, обложка у фото-объектов — как на плитке. До
 * карточки — миниатюра обложки на месте будущего кадра.
 */
export function previewFileOf(entry: CatalogEntry): ViewerFile {
  const cover = itemCover(entry)
  const video = entry.duration_s !== null
  return {
    seed: cover.seed,
    kind: cover.kind,
    family: cover.family,
    type: video ? 'video' : 'photo',
    aspect: video ? (entry.type === 'promo' ? '16:9' : '9:16') : '3:4',
    durationSeconds: entry.duration_s ?? undefined,
    label: entry.id,
    thumb: entry.cover.url ?? null,
  }
}

/**
 * Файл объекта, который показывает плитка: мастер или монтаж у видео, у фото-объекта — файл
 * обложки (та же миниатюра), иначе первый. Из карточки — с превью для просмотра.
 */
function coverFileOf(detail: ItemDetail): ViewerFile | undefined {
  const entry = detail.entry
  const files = detail.files
  const file =
    (entry.duration_s !== null
      ? files.find((candidate) => candidate.role === 'master' || candidate.role === 'montage')
      : undefined) ??
    files.find((candidate) => entry.cover.url && candidate.thumb.url === entry.cover.url) ??
    files.find(
      (candidate) => candidate.media === (entry.duration_s !== null ? 'video' : 'photo'),
    ) ??
    files[0]
  return file ? { ...toViewerFile(entry, file), label: entry.id } : undefined
}

/** «PPV-073 · День рождения, торт, кружево · 13:24». */
function previewTitle(entry: CatalogEntry): string {
  const length = entry.duration_s === null ? null : formatDuration(entry.duration_s)
  return [entry.id, entry.title, length].filter(Boolean).join(' · ')
}

interface EntriesViewerProps {
  /** Отфильтрованный и отсортированный список сетки: стрелки идут по нему. */
  entries: readonly CatalogEntry[]
  current: ItemId
  onCurrentChange: (id: ItemId) => void
  onClose: () => void
  onOpen: (id: ItemId) => void
}

/**
 * Просмотр поверх сетки раздела (DESIGN §3.5): стрелки и `←` `→` листают соседние
 * объекты того списка, что на экране, «Открыть» ведёт на страницу объекта, «×», `Esc`
 * и «Назад» возвращают в сетку с прежним выделением.
 */
export function EntriesViewer({
  entries,
  current,
  onCurrentChange,
  onClose,
  onOpen,
}: EntriesViewerProps) {
  const model = useCurrentModel().code
  const preview = useMemo(() => entries.map(previewFileOf), [entries])
  // Видео грузится при открытии просмотра, а не в сетке (SPEC §12.0): карточка объекта.
  const detail = useItem(model, current, {
    refetchInterval: (item) =>
      item && isBuilding([coverFileOf(item)]) ? BUILDING_REFETCH_MS : false,
  }).data
  const shown = detail?.entry.id === current ? coverFileOf(detail) : undefined
  useReturnFocus()
  const index = entries.findIndex((entry) => entry.id === current)
  const entry = entries[index]
  const files = useMemo(
    () => (shown ? preview.map((file, at) => (at === index ? shown : file)) : preview),
    [preview, shown, index],
  )
  if (!entry) {
    return null
  }
  return (
    <Viewer
      open
      onOpenChange={(open) => !open && onClose()}
      title={previewTitle(entry)}
      files={files}
      index={index}
      onIndexChange={(next) => {
        const target = entries[next]
        if (target) {
          onCurrentChange(target.id)
        }
      }}
      actions={
        <Button variant="bar" onClick={() => onOpen(entry.id)}>
          Открыть
        </Button>
      }
      info={
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium text-base">{entry.title}</p>
          <p className="text-muted-foreground">{metaLine(entry)}</p>
        </div>
      }
    />
  )
}

/**
 * Фокус возвращается туда, откуда открыли просмотр, — в сетку: у окна просмотра нет
 * кнопки-источника, и без этого стрелки и `Space` после выхода не работали бы (§7.8).
 */
function useReturnFocus() {
  const [origin] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(
    () => () => {
      requestAnimationFrame(() => {
        if (origin?.isConnected) {
          origin.focus({ preventScroll: true })
        }
      })
    },
    [origin],
  )
}

interface PreviewAddress {
  /** Объект в просмотре из адреса: `?preview=PPV-073`. */
  preview: ItemId | undefined
  /** Меняет адрес: `push` — новая запись истории, иначе на месте. */
  change: (preview: ItemId | undefined, options: { push: boolean }) => void
}

/**
 * Просмотр из сетки со своей записью в истории: `Space` добавляет запись, стрелки меняют
 * её на месте, выход — «Назад». Открытый по ссылке просмотр закрывается на месте.
 */
export function useEntryPreview({ preview, change }: PreviewAddress) {
  const router = useRouter()
  const pushed = useRef(false)
  const open = useCallback(
    (id: ItemId) => {
      pushed.current = preview === undefined
      change(id, { push: preview === undefined })
    },
    [change, preview],
  )
  const move = useCallback((id: ItemId) => change(id, { push: false }), [change])
  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false
      router.history.back()
      return
    }
    change(undefined, { push: false })
  }, [change, router])
  return { current: preview, open, move, close }
}
