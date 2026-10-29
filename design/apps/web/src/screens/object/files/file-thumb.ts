import {
  type CatalogEntry,
  type FypVersion,
  type ItemFile,
  type ItemId,
  itemTypeOf,
  type MasterFrame,
  type ThumbRef,
  thumbSubject,
} from '@contentops/contracts'
import { type CoverFamily, type CoverKind, pickCoverFamily } from '@contentops/ui/components/thumb'
import { itemCoverById } from '@/lib/item-cover'

/**
 * Как нарисовать файл объекта синтетической миниатюрой (DESIGN §7.9): файлы берут
 * семейство своего объекта, чтобы папка не пестрила; кадры мастера — тот же мотив с
 * другим кадрированием и светом.
 */
export interface FileCover {
  seed: string
  kind: CoverKind
  family: CoverFamily
  frame?: number
}

export function objectFamily(id: ItemId): CoverFamily {
  const cover = itemCoverById(id)
  return cover.family ?? pickCoverFamily(cover.seed, cover.kind)
}

const FRAME_PART = /^frame(\d+)$/

/** Обложка по ссылке на миниатюру: `PPV-073/frame03` — третий кадр мастера PPV-073. */
export function coverOfThumb(ref: ThumbRef, fallback: ItemId): FileCover {
  const subject = thumbSubject(ref)
  const owner = subject.item_id ?? fallback
  const kind = itemTypeOf(owner)
  const frame = FRAME_PART.exec(subject.part ?? '')?.[1]
  if (frame !== undefined) {
    return { seed: owner, kind, family: objectFamily(owner), frame: Number(frame) }
  }
  const seed = subject.part === null ? owner : ref.key
  return { seed, kind, family: objectFamily(owner) }
}

/** Мастер — это обложка объекта; остальные файлы — свои сцены в том же семействе. */
export function fileCover(entry: CatalogEntry, file: ItemFile): FileCover {
  if (file.role === 'master' || file.role === 'montage') {
    return { seed: entry.id, kind: entry.type, family: objectFamily(entry.id) }
  }
  return coverOfThumb(file.thumb, entry.id)
}

export function frameCover(entry: CatalogEntry, frame: MasterFrame): FileCover {
  return coverOfThumb(frame.thumb, entry.id)
}

/** Версия мастера: текущая — обложка объекта, прежние — та же сцена в другом свете. */
export function versionCover(entry: CatalogEntry, version: number, current: number): FileCover {
  return {
    seed: entry.id,
    kind: entry.type,
    family: objectFamily(entry.id),
    frame: version === current ? undefined : 40 + version,
  }
}

/** Версия фупа для страницы: тот же монтаж в другом кадрировании. */
export function versionTileCover(entry: CatalogEntry, version: FypVersion): FileCover {
  return {
    seed: entry.id,
    kind: entry.type,
    family: objectFamily(entry.id),
    frame: 20 + version.no,
  }
}
