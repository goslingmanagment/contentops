import type { DownloadKind } from './commands/objects'
import type { CatalogEntry } from './domain/catalog'
import type { ItemFile } from './domain/files'
import { exportName, fanFileName, type NameRole, type NameSlot } from './download-name'

/**
 * Что отдаёт каждый вид скачивания (DESIGN §4.4–4.5, SPEC §9.3) и как называются его
 * файлы (naming §3–6). Порядок файлов — порядок заливки.
 */

export type DownloadEntry = Pick<CatalogEntry, 'id' | 'title' | 'title_en' | 'type'>

export interface DeliveryOptions {
  /** Строка плана: аккаунт, день и время в имени. */
  slot?: NameSlot | null
  /** Уникальная версия фупа в строке плана. */
  uniq?: number | null
  /** Прежняя версия мастера («v1 · до правки»); без неё — текущая. */
  version?: number | null
  /** Модель: у файла «Для фана» имя `lora-custom.mp4`. */
  model?: string
}

/** Роль файла в имени и номер порядковой роли. */
export interface FileHandle {
  role: NameRole
  ordinal: number | null
}

/** Файл выдачи: имя, из какого файла объекта и что с ним сделано. */
export interface DeliveredFile extends FileHandle {
  name: string
  file: ItemFile
  /** «кадр 7 · обработанный». */
  note: string | null
}

/** Выдача: один файл или архив; у архива `files` — его состав по порядку. */
export interface Delivery {
  name: string
  archive: boolean
  files: DeliveredFile[]
}

export function mainVideo(files: readonly ItemFile[]): ItemFile | undefined {
  return files.find((file) => file.role === 'master' || file.role === 'montage')
}

const byPosition = (left: ItemFile, right: ItemFile) =>
  (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)

const photosOf = (files: readonly ItemFile[]) => files.filter((file) => file.media === 'photo')

/** Номер среди файлов той же роли по порядку: `pic03`, `clip02`. */
function rankAmong(files: readonly ItemFile[], file: ItemFile, same: (other: ItemFile) => boolean) {
  return files.filter(same).sort(byPosition).indexOf(file) + 1
}

/**
 * Роль файла в имени (naming §3): мастер и монтаж фупа — `master`; кадр сета — `raw`
 * с номером кадра по съёмке; остальные фото — `pic`, видео — `clip` по порядку.
 */
export function handleOf(
  entry: DownloadEntry,
  files: readonly ItemFile[],
  file: ItemFile,
): FileHandle {
  switch (file.role) {
    case 'master':
    case 'montage':
      return { role: 'master', ordinal: null }
    case 'teaser':
      return { role: 'teaser', ordinal: null }
    case 'raw':
    case 'source':
      return { role: 'raw', ordinal: rankAmong(files, file, (other) => other.role === file.role) }
    default:
      if (entry.type === 'set' && file.media === 'photo') {
        return { role: 'raw', ordinal: photosOf(files).indexOf(file) + 1 }
      }
      return file.media === 'video'
        ? {
            role: 'clip',
            ordinal: rankAmong(
              files,
              file,
              (other) => other.media === 'video' && other.role === file.role,
            ),
          }
        : { role: 'pic', ordinal: rankAmong(files, file, (other) => other.media === 'photo') }
  }
}

/** Длительность — только у PPV и кастомов (naming §5); у мастера — выданной версии. */
function durationOf(entry: DownloadEntry, file: ItemFile, version: number): number | null {
  if ((entry.type !== 'ppv' && entry.type !== 'custom') || file.media !== 'video') return null
  return file.versions.find((candidate) => candidate.no === version)?.duration_s ?? file.duration_s
}

type ExtOf = (file: ItemFile) => string

/** Копия для платформы: видео — mp4, фото — jpg. */
const platformExt: ExtOf = (file) => (file.media === 'video' ? 'mp4' : 'jpg')
/** Исходник и фото 100 % — в своём формате. */
const originalExt: ExtOf = (file) => file.file_name.split('.').pop() ?? ''

function deliver(
  entry: DownloadEntry,
  file: ItemFile,
  handle: FileHandle,
  options: DeliveryOptions,
  ext: string,
  note: string | null = null,
): DeliveredFile {
  const main = handle.role === 'master'
  const version = main ? (options.version ?? file.current_version) : file.current_version
  const name = exportName({
    id: entry.id,
    title: entry.title,
    title_en: entry.title_en,
    role: handle.role,
    ordinal: handle.ordinal,
    uniq: main ? (options.uniq ?? null) : null,
    version: main && !options.uniq ? version : null,
    slot: options.slot ?? null,
    duration_s: durationOf(entry, file, version),
    ext,
  })
  return { ...handle, name, file, note }
}

/** Файлы по порядку `order`, каждый под своей ролью. */
function each(
  entry: DownloadEntry,
  files: readonly ItemFile[],
  picked: readonly ItemFile[],
  options: DeliveryOptions,
  ext: ExtOf,
): DeliveredFile[] {
  return picked.map((file) =>
    deliver(entry, file, handleOf(entry, files, file), options, ext(file)),
  )
}

/**
 * Кадры сета для заливки (DESIGN §4.5): отобранные в заданном порядке под именами
 * `ed01…`, обработанный кадр идёт вместо исходного. Пока ничего не отобрано — все
 * кадры по съёмке.
 */
function setUpload(entry: DownloadEntry, files: readonly ItemFile[], options: DeliveryOptions) {
  const photos = photosOf(files)
  const selected = photos.filter((file) => file.selected).sort(byPosition)
  return (selected.length > 0 ? selected : photos).map((file, index) =>
    deliver(
      entry,
      file,
      { role: 'ed', ordinal: index + 1 },
      options,
      'jpg',
      `кадр ${photos.indexOf(file) + 1} · ${file.processed ? 'обработанный' : 'исходный'}`,
    ),
  )
}

/** Для заливки без мастера: секстинг по порядку, у лайфа — кадры с назначением и видео. */
function uploadInOrder(entry: DownloadEntry, files: readonly ItemFile[]) {
  return files
    .filter(
      (file) =>
        file.role !== 'teaser' &&
        (entry.type !== 'life' || file.media === 'video' || file.assignment !== null),
    )
    .sort(byPosition)
}

function membersOf(
  entry: DownloadEntry,
  files: readonly ItemFile[],
  kind: Exclude<DownloadKind, 'fan'>,
  options: DeliveryOptions,
): DeliveredFile[] {
  const video = mainVideo(files)
  const teaser = files.find((file) => file.role === 'teaser')
  switch (kind) {
    case 'platform':
      if (entry.type === 'set') return setUpload(entry, files, options)
      return each(entry, files, video ? [video] : uploadInOrder(entry, files), options, platformExt)
    case 'photos': {
      // Кадры сета — по съёмке, остальные фото — в порядке объекта.
      const photos = photosOf(files)
      const ordered = entry.type === 'set' ? photos : photos.sort(byPosition)
      return each(entry, files, ordered, options, originalExt)
    }
    case 'teaser':
      return each(entry, files, teaser ? [teaser] : [], options, platformExt)
    case 'source':
      return video
        ? each(entry, files, [video], options, originalExt)
        : each(
            entry,
            files,
            files.filter((file) => file.role === 'raw'),
            options,
            originalExt,
          )
    default:
      return each(entry, files, video ? [video] : [], options, platformExt)
  }
}

/**
 * Что уйдёт по нажатию: один файл или архив со списком по порядку заливки. Архив
 * называется как его файлы без номера: `SET-074_chtenie-knigi-stringi_ed.zip`
 * (naming имени архива не задаёт — DESIGN §10).
 */
export function deliveryOf(
  entry: DownloadEntry,
  files: readonly ItemFile[],
  kind: DownloadKind,
  options: DeliveryOptions = {},
): Delivery {
  if (kind === 'fan') {
    const video = mainVideo(files)
    const name = fanFileName(options.model ?? 'lora')
    const fan = video
      ? [{ role: 'master' as const, ordinal: null, name, file: video, note: null }]
      : []
    return { name, archive: false, files: fan }
  }
  return packed(entry, membersOf(entry, files, kind, options), options)
}

/** Один файл отдаётся как есть, несколько — архивом по роли первого. */
function packed(
  entry: DownloadEntry,
  members: DeliveredFile[],
  options: DeliveryOptions,
): Delivery {
  const [first] = members
  if (!first) return { name: '', archive: false, files: [] }
  if (members.length === 1) return { name: first.name, archive: false, files: members }
  const name = exportName({
    id: entry.id,
    title: entry.title,
    title_en: entry.title_en,
    role: first.role,
    slot: options.slot ?? null,
    ext: 'zip',
  })
  return { name, archive: true, files: members }
}

/**
 * Выбранные файлы объекта (полоса выделения → «Скачать»): каждый под своей ролью и в
 * своём формате.
 */
export function selectionDelivery(
  entry: DownloadEntry,
  files: readonly ItemFile[],
  picked: readonly ItemFile[],
): Delivery {
  return packed(entry, each(entry, files, picked, {}, originalExt), {})
}

/** Будущее имя: подсказка пункта «Скачать ▾», строка плана, квитанция. */
export function downloadFileName(
  entry: DownloadEntry,
  files: readonly ItemFile[],
  kind: DownloadKind,
  options: DeliveryOptions = {},
): string {
  return deliveryOf(entry, files, kind, options).name
}
