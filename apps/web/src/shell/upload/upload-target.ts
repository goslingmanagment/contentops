import type { ItemId, MediaKind, PpvKind, UploadKind, UploadTargetRef } from '@contentops/contracts'

/**
 * Куда привяжется загрузка: объект или строка плана (DESIGN §3.7). Строка, ждущая
 * монтаж, знает, какого вида файл ждёт: окно «Загрузить» открывается с этим видом. Свой
 * монтаж для PPV из кастома (§4.5) — новый PPV с этим видом и названием, принятый при загрузке.
 */
export type UploadTarget =
  | { kind: 'item'; itemId: ItemId; title: string }
  | { kind: 'plan-row'; rowId: string; title: string; expects: UploadKind | null }
  | { kind: 'ppv-from'; itemId: ItemId; title: string; ppvKind: PpvKind; ppvTitle: string }

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
  if (left.kind === 'ppv-from' && right.kind === 'ppv-from') {
    return (
      left.itemId === right.itemId &&
      left.ppvKind === right.ppvKind &&
      left.ppvTitle === right.ppvTitle
    )
  }
  return false
}

/** Цель в команде загрузки. */
export function targetRef(target: UploadTarget): UploadTargetRef {
  switch (target.kind) {
    case 'item':
      return { kind: 'item', item_id: target.itemId }
    case 'plan-row':
      return { kind: 'plan_row', row_id: target.rowId }
    case 'ppv-from':
      return {
        kind: 'ppv_from_custom',
        item_id: target.itemId,
        ppv_kind: target.ppvKind,
        title: target.ppvTitle,
      }
  }
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
