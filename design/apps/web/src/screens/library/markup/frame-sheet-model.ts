import type { FrameCheck, ItemDetail } from '@contentops/contracts'
import { timelineTimecode } from '@/data/search'
import { type FileCover, fileCover, frameCover } from '@/screens/object/files/file-thumb'

/** Кадр листа: кадр мастера («4:10») или фото секстинга («фото 3»). */
export interface SheetFrame {
  /** Ключ для сервера: `t:250` — кадр мастера на 4:10, иначе ключ файла. */
  key: string
  caption: string
  cover: FileCover
  aspect: '9:16' | '3:4'
}

/**
 * Что смотреть перед отправкой (DESIGN §4.20): у видео — кадры мастера, у секстинга —
 * его фото и клипы по порядку.
 */
export function sheetFramesOf(detail: ItemDetail): SheetFrame[] {
  if (detail.frames.length > 0) {
    return detail.frames.map((frame) => ({
      key: `t:${frame.t_s}`,
      caption: timelineTimecode(frame.t_s),
      cover: frameCover(detail.entry, frame),
      aspect: '9:16',
    }))
  }
  return detail.files
    .filter((file) => file.role === 'photo' || file.role === 'clip')
    .map((file) => ({
      key: file.key,
      caption: file.label,
      cover: fileCover(detail.entry, file),
      aspect: file.media === 'video' ? '9:16' : '3:4',
    }))
}

/** Версия мастера, для которой смотрят кадры: «проверено для v2». */
export function sheetVersionOf(detail: ItemDetail): number {
  return detail.files.find((file) => file.role === 'master')?.current_version ?? 1
}

/** Кадры видео — это один ролик: с отмеченным кадром его целиком не отправить. */
export function isWholeVideo(detail: ItemDetail): boolean {
  return detail.frames.length > 0
}

export type SheetCheck =
  | { kind: 'none' }
  | { kind: 'current'; check: FrameCheck }
  /** Проверяли прежнюю версию: после правки кадры смотрят заново. */
  | { kind: 'stale'; check: FrameCheck }

export function sheetCheckOf(detail: ItemDetail): SheetCheck {
  const check = detail.frame_check
  if (!check) {
    return { kind: 'none' }
  }
  return check.version === sheetVersionOf(detail)
    ? { kind: 'current', check }
    : { kind: 'stale', check }
}

/** С чего начинается лист: отметки последней проверки этой же версии. */
export function initialBlocked(detail: ItemDetail): ReadonlySet<string> {
  const state = sheetCheckOf(detail)
  return new Set(state.kind === 'current' ? state.check.blocked : [])
}
