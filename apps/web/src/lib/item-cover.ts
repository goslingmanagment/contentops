import { type CatalogEntry, type ItemId, itemTypeOf } from '@contentops/contracts'
import type { MosaicCount } from '@contentops/ui/components/mosaic'
import type { CoverFamily, CoverKind } from '@contentops/ui/components/thumb'
import { compositionLabel } from './words'

/**
 * Как нарисовать обложку объекта каталога синтетической миниатюрой (DESIGN §7.9):
 * семейство выбирается по хэшу ID, кроме объектов, у которых оно задано нормой.
 */
const FAMILY_BY_ID: Readonly<Partial<Record<ItemId, CoverFamily>>> = {
  'PPV-073': 'party',
}

export interface ItemCover {
  seed: string
  kind: CoverKind
  family?: CoverFamily
  durationSeconds?: number
  /** «22 фото», у смешанного — «22 файла»; у видео с длительностью — нет. */
  countLabel?: string
  /** То же числом для малой ячейки мозаики: значок и «109». */
  count?: MosaicCount
  versionCount?: number
}

function countOf(entry: CatalogEntry): MosaicCount | undefined {
  const photos = entry.photo_count ?? 0
  const videos = entry.video_count ?? 0
  if (photos + videos === 0) {
    return undefined
  }
  const media = photos > 0 && videos > 0 ? 'mixed' : photos > 0 ? 'photo' : 'video'
  return { value: photos + videos, media }
}

export function itemCover(entry: CatalogEntry): ItemCover {
  const duration = entry.duration_s ?? undefined
  return {
    seed: entry.cover.key,
    kind: entry.type,
    family: FAMILY_BY_ID[entry.id],
    durationSeconds: duration,
    countLabel: duration === undefined ? compositionLabel(entry) : undefined,
    count: duration === undefined ? countOf(entry) : undefined,
    versionCount: entry.version_count,
  }
}

/** Обложка по одному ID, когда записи каталога под рукой нет (цель загрузки). */
export function itemCoverById(id: ItemId): Pick<ItemCover, 'seed' | 'kind' | 'family'> {
  return { seed: id, kind: itemTypeOf(id), family: FAMILY_BY_ID[id] }
}
