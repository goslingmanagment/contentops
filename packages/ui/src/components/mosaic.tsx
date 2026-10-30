import { formatNumber } from '@contentops/contracts/format'
import { cn } from 'cn'
import { FilesIcon, ImagesIcon, VideoIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import type { CoverFamily, CoverKind } from './cover/families'
import type { CoverAspect } from './cover/scene'
import { CoverLabel, Thumb } from './thumb'

/** Состав ячейки числом: на малой ячейке — значок и число, слово не помещается. */
export interface MosaicCount {
  value: number
  media: 'photo' | 'video' | 'mixed'
}

const COUNT_ICON = { photo: ImagesIcon, video: VideoIcon, mixed: FilesIcon } as const

export interface MosaicTile {
  seed: string
  kind?: CoverKind
  family?: CoverFamily
  durationSeconds?: number
  /** «22 фото», «22 файла» — словами на большой ячейке. */
  countLabel?: string
  /** То же на малой ячейке: «109» со значком файлов вместо обрезанного «109 файл…». */
  count?: MosaicCount
  /** Пропорция кадра, если он вписывается в ячейку: YouTube в Промо — 16:9 (§7.6). */
  mediaAspect?: CoverAspect
  /** Настоящая картинка поверх заглушки. */
  src?: string | null
}

/**
 * Раскладки мозаики (DESIGN §4.1): `feature` — большая обложка слева (2/3) и две малые
 * справа; `columns` — три вертикальных кадра (FYP); `grid-6` — 3 × 2 (Сеты);
 * `grid-4` — 2 × 2 (Лайф).
 */
export type MosaicLayout = 'feature' | 'columns' | 'grid-6' | 'grid-4'

const cellCount: Record<MosaicLayout, number> = { feature: 3, columns: 3, 'grid-6': 6, 'grid-4': 4 }

const layoutClass: Record<MosaicLayout, string> = {
  feature: 'grid-cols-[2fr_1fr] grid-rows-2 [&>*:first-child]:row-span-2',
  columns: 'grid-cols-3',
  'grid-6': 'grid-cols-3 grid-rows-2',
  'grid-4': 'grid-cols-2 grid-rows-2',
}

interface MosaicProps extends Omit<ComponentProps<'div'>, 'children'> {
  tiles: readonly MosaicTile[]
  layout?: MosaicLayout
}

/** Мозаика обложек папки или группы. Пустые места держатся серыми, без иконок. */
export function Mosaic({ tiles, layout = 'feature', className, ...props }: MosaicProps) {
  const slots = Array.from({ length: cellCount[layout] }, (_, index) => tiles[index])
  return (
    <div
      data-slot="mosaic"
      className={cn(
        'grid aspect-[211/132] gap-0.5 overflow-hidden',
        layoutClass[layout],
        className,
      )}
      {...props}
    >
      {slots.map((tile, index) => {
        if (!tile) {
          return <div key={`empty-${index}`} className="bg-muted" />
        }
        const big = layout === 'feature' && index === 0
        return (
          <Thumb
            key={tile.seed}
            fill
            seed={tile.seed}
            kind={tile.kind}
            family={tile.family}
            aspect={cellAspect(layout, index)}
            mediaAspect={tile.mediaAspect}
            src={tile.src}
            durationSeconds={tile.durationSeconds}
            countLabel={big ? tile.countLabel : undefined}
            overlay={
              big || tile.durationSeconds !== undefined ? undefined : (
                <SmallCount count={tile.count} label={tile.countLabel} />
              )
            }
            className="rounded-none"
          />
        )
      })}
    </div>
  )
}

/** Малая ячейка: значок состава и число; слово целиком — в подсказке и для чтения с экрана. */
function SmallCount({ count, label }: { count: MosaicCount | undefined; label?: string }) {
  if (!count) {
    return null
  }
  const Icon = COUNT_ICON[count.media]
  return (
    <CoverLabel className="bottom-1.5 left-1.5" title={label}>
      <Icon aria-hidden className="size-3" />
      <span aria-hidden>{formatNumber(count.value)}</span>
      {label ? <span className="sr-only">{label}</span> : null}
    </CoverLabel>
  )
}

/** Пропорция, ближайшая к ячейке: у FYP вертикальные кадры, большая ячейка почти квадрат. */
function cellAspect(layout: MosaicLayout, index: number): CoverAspect {
  if (layout === 'columns') {
    return '9:16'
  }
  return layout === 'feature' && index === 0 ? '1:1' : '3:4'
}
