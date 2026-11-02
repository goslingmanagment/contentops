import {
  type CatalogEntry,
  formatDuration,
  type ItemDetail,
  type ItemFile,
  type ItemType,
  UNIQ_LEVEL_LABEL,
} from '@contentops/contracts'
import type { ViewerFile } from '@contentops/ui/components/viewer'
import { viewerMedia } from '@/lib/viewer-media'
import { fypVersionKey } from '../files/file-keys'
import { fileCover } from '../files/file-thumb'
import { byKey, byPosition } from '../files/ordered-files'
import type { ObjectSearch } from '../search'

/** Файл в просмотре с ключом адреса `?view=` и подписью для заголовка. */
export interface ViewerEntry {
  key: string
  file: ViewerFile
  /** «мастер v2 · 13:24», «фото 7», «версия 2 · подрезка». */
  caption: string
}

export function toViewerFile(entry: CatalogEntry, file: ItemFile, seedSuffix = ''): ViewerFile {
  const cover = fileCover(entry, file)
  return {
    seed: `${cover.seed}${seedSuffix}`,
    kind: cover.kind,
    family: cover.family,
    type: file.media,
    aspect: file.thumb.ratio,
    ratio: file.width / file.height,
    durationSeconds: file.duration_s ?? undefined,
    label: file.label,
    ...viewerMedia(file.thumb, file.preview),
  }
}

function captionOf(file: ItemFile): string {
  const version = file.versions.length > 1 ? ` v${file.current_version}` : ''
  const length = file.duration_s === null ? '' : ` · ${formatDuration(file.duration_s)}`
  return `${file.label}${version}${length}`
}

function fileEntries(detail: ItemDetail, files: readonly ItemFile[]): ViewerEntry[] {
  return files.map((file) => ({
    key: file.key,
    file: toViewerFile(detail.entry, file),
    caption: captionOf(file),
  }))
}

const ROLE_ORDER: Readonly<Record<ItemFile['role'], number>> = {
  master: 0,
  montage: 0,
  teaser: 1,
  source: 2,
  photo: 3,
  clip: 4,
  raw: 3,
  promo_link: 3,
}

/** Порядок листания стрелками — как файлы стоят на странице объекта (DESIGN §3.5). */
const ORDER_BY_TYPE: Partial<
  Record<ItemType, (detail: ItemDetail, search: ObjectSearch) => ItemFile[]>
> = {
  set: (detail, search) => {
    const frames = detail.files.filter((file) => file.role === 'photo')
    return search.frames === 'picked'
      ? byPosition(frames.filter((file) => file.selected))
      : byKey(frames)
  },
  sexting: (detail) => byPosition(detail.files),
  raw: (detail) => byPosition(detail.files),
}

function orderedFiles(detail: ItemDetail, search: ObjectSearch): ItemFile[] {
  const byType = ORDER_BY_TYPE[detail.entry.type]
  if (byType) {
    return byType(detail, search)
  }
  return [...detail.files].sort(
    (left, right) =>
      ROLE_ORDER[left.role] - ROLE_ORDER[right.role] ||
      (left.position ?? 0) - (right.position ?? 0),
  )
}

function versionEntries(detail: ItemDetail): ViewerEntry[] {
  const montage = detail.files.find((file) => file.role === 'montage')
  if (!montage) {
    return []
  }
  return detail.fyp_versions.map((version) => ({
    key: fypVersionKey(version.no),
    file: {
      ...toViewerFile(detail.entry, montage, `:v${version.no}`),
      durationSeconds: version.duration_s,
      label: `версия ${version.no}`,
      // Сама версия для страницы, а не монтаж: свой файл и своё превью.
      ...viewerMedia(version.thumb, version.preview),
    },
    caption: `версия ${version.no} · ${UNIQ_LEVEL_LABEL[version.level]}`,
  }))
}

/** Все файлы объекта для просмотра по порядку страницы. */
export function viewerEntries(detail: ItemDetail, search: ObjectSearch): ViewerEntry[] {
  return [...fileEntries(detail, orderedFiles(detail, search)), ...versionEntries(detail)]
}

/**
 * Версия мастера для `?v=1` и сравнения: её собственные миниатюра, превью и кадры на общих
 * с другими версиями таймкодах (DESIGN §3.5).
 */
export function masterVersionFile(detail: ItemDetail, version: number): ViewerFile | null {
  const master = detail.files.find((file) => file.role === 'master')
  if (!master) {
    return null
  }
  const suffix = version === master.current_version ? '' : `:v${version}`
  const own = master.versions.find((candidate) => candidate.no === version)
  const file = toViewerFile(detail.entry, master, suffix)
  return {
    ...file,
    durationSeconds: own?.duration_s ?? master.duration_s ?? undefined,
    ...(own?.preview ? viewerMedia(own.thumb, own.preview) : {}),
    frames: own?.frames?.map((frame) => ({ seconds: frame.t_s, src: frame.thumb.url ?? null })),
  }
}

/** Пока превью собирается, карточку перечитывают — готовое превью встаёт само (DESIGN §3.5). */
export const BUILDING_REFETCH_MS = 3000

export function isBuilding(files: readonly (ViewerFile | undefined)[]): boolean {
  return files.some((file) => file?.src === null && file.building)
}
