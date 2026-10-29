import { type ThumbRef, thumbSubject } from '@contentops/contracts'
import type { MosaicLayout, MosaicTile } from '@contentops/ui/components/mosaic'
import type { CoverAspect, CoverKind } from '@contentops/ui/components/thumb'

export interface MemberCover {
  seed: string
  kind: CoverKind | undefined
  /** Горизонтальный кадр (YouTube) вписывается в ячейку целиком (§7.6). */
  mediaAspect: CoverAspect | undefined
}

/**
 * Как нарисовать миниатюру материала промо: сид — ключ миниатюры, тип — у исходного
 * объекта, кадр 16:9 вписывается, вертикальный — обрезается по центру.
 */
export function memberCover(thumb: ThumbRef): MemberCover {
  return {
    seed: thumb.key,
    kind: thumbSubject(thumb).type ?? 'promo',
    mediaAspect: thumb.ratio === '16:9' ? '16:9' : undefined,
  }
}

/** Мозаика папки канала или подборки из первых миниатюр. */
export function mosaicOf(thumbs: readonly ThumbRef[]): MosaicTile[] {
  return thumbs.map((thumb) => {
    const cover = memberCover(thumb)
    return { seed: cover.seed, kind: cover.kind, mediaAspect: cover.mediaAspect }
  })
}

/** Раскладка мозаики по пропорции кадров: 16:9 — сетка 2 × 2, остальное — большая и две. */
export function mosaicLayoutOf(thumbs: readonly ThumbRef[]): MosaicLayout {
  return thumbs[0]?.ratio === '16:9' ? 'grid-4' : 'feature'
}
