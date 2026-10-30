import { type DraftFile, type FileRole, formatNumber, type InboxGroup } from '@contentops/contracts'
import type { MosaicTile } from '@contentops/ui/components/mosaic'
import type { CoverKind } from '@contentops/ui/components/thumb'
import type { ViewerFile } from '@contentops/ui/components/viewer'

/**
 * Как нарисовать файлы черновика синтетическими миниатюрами (DESIGN §7.9): обложка —
 * по ключу миниатюры файла, семейство — по корню Я.Диска, откуда пачка приехала. Тип
 * черновика здесь не участвует: после «Тип → Сырьё» файлы те же, и кадры не меняются.
 */

/** Корни Я.Диска, по которым понятно, что лежит внутри (§9.3). */
const ROOT_KIND: Readonly<Record<string, CoverKind>> = {
  '1. PPV': 'ppv',
  '2. FYP': 'fyp',
  '3. Customs': 'custom',
  '4. Sets': 'set',
  '5. Sextings': 'sexting',
  '6. Life': 'life',
  '9. SMM': 'promo',
}

export function groupKind(group: InboxGroup): CoverKind | undefined {
  return ROOT_KIND[group.root]
}

/** Что показать первым в мозаике: мастер и монтаж раньше фото. */
const ROLE_WEIGHT: Record<FileRole, number> = {
  master: 0,
  montage: 1,
  teaser: 2,
  clip: 3,
  source: 4,
  raw: 5,
  photo: 6,
  promo_link: 7,
}

const MOSAIC_CELLS = 3

/**
 * Мозаика плитки группы (DESIGN §4.8): первые кадры, у видео — длительность, у набора
 * фото на большой ячейке — число фото. Пока файлов нет (архив качается), ячейки серые.
 */
export function groupMosaic(group: InboxGroup): MosaicTile[] {
  const kind = groupKind(group)
  const photos = group.files.filter((file) => file.media === 'photo').length
  const photosOnly = photos === group.files.length
  return [...group.files]
    .sort((left, right) => ROLE_WEIGHT[left.role] - ROLE_WEIGHT[right.role])
    .slice(0, MOSAIC_CELLS)
    .map((file, index) => ({
      seed: file.thumb.key,
      src: file.thumb.url ?? null,
      kind,
      durationSeconds: file.duration_s ?? undefined,
      countLabel:
        photosOnly && index === 0 && photos > 1 ? `${formatNumber(photos)} фото` : undefined,
    }))
}

export function viewerFileOf(file: DraftFile, kind: CoverKind | undefined): ViewerFile {
  return {
    seed: file.thumb.key,
    type: file.media,
    aspect: file.thumb.ratio,
    kind,
    durationSeconds: file.duration_s ?? undefined,
    label: file.role_label,
  }
}
