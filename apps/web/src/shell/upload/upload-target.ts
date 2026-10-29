import type { ItemId, MediaKind, UploadKind, UploadTargetRef } from '@contentops/contracts'

/**
 * Куда привяжется загрузка: объект или строка плана (DESIGN §3.7). Строка, ждущая
 * монтаж, знает, какого вида файл ждёт: окно «Загрузить» открывается с этим видом.
 */
export type UploadTarget =
  | { kind: 'item'; itemId: ItemId; title: string }
  | { kind: 'plan-row'; rowId: string; title: string; expects: UploadKind | null }

/** Вид файла в окне «Загрузить» по умолчанию: чего ждёт цель, иначе тизер; без цели — «Другое». */
export function defaultUploadKind(target: UploadTarget | null): UploadKind {
  if (target === null) {
    return 'other'
  }
  return target.kind === 'plan-row' && target.expects ? target.expects : 'teaser'
}

export function sameTarget(left: UploadTarget | null, right: UploadTarget | null): boolean {
  if (left === null || right === null) {
    return left === right
  }
  if (left.kind === 'item' && right.kind === 'item') {
    return left.itemId === right.itemId && left.title === right.title
  }
  if (left.kind === 'plan-row' && right.kind === 'plan-row') {
    return (
      left.rowId === right.rowId && left.title === right.title && left.expects === right.expects
    )
  }
  return false
}

/** Цель в команде загрузки. */
export function targetRef(target: UploadTarget): UploadTargetRef {
  return target.kind === 'item'
    ? { kind: 'item', item_id: target.itemId }
    : { kind: 'plan_row', row_id: target.rowId }
}

const VIDEO_EXTENSIONS = /\.(mov|mp4|m4v|avi|mkv|webm|mts)$/i

/** Видео или фото — по типу файла, а без типа по расширению. */
export function mediaOf(file: Pick<File, 'name' | 'type'>): MediaKind {
  if (file.type.startsWith('video/')) {
    return 'video'
  }
  if (file.type.startsWith('image/')) {
    return 'photo'
  }
  return VIDEO_EXTENSIONS.test(file.name) ? 'video' : 'photo'
}
