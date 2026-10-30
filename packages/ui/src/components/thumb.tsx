import { formatDuration } from '@contentops/contracts/format'
import { cn } from 'cn'
import { LayersIcon, PlayIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { CoverArt } from './cover/cover-art'
import { type CoverFamily, type CoverKind, pickCoverFamily } from './cover/families'
import { aspectRatioValue, type CoverAspect } from './cover/scene'

export type { CoverAspect, CoverFamily, CoverKind }
/** Семейство обложки объекта: файлы внутри объекта берут его, чтобы не пестрить. */
export { pickCoverFamily }

export interface ThumbProps extends Omit<ComponentProps<'div'>, 'children'> {
  /** ID объекта или файла: от него зависят семейство, мотив и оттенок. */
  seed: string
  /** Тип объекта: сужает выбор семейств (§7.9). */
  kind?: CoverKind
  /** Явное семейство, например `party` для PPV-073. */
  family?: CoverFamily
  /** Пропорция ячейки. По умолчанию 3:4. */
  aspect?: CoverAspect
  /**
   * Пропорция самого кадра, если она не совпадает с ячейкой: кадр вписывается целиком
   * на `--muted` (мастер 9:16, горизонтальное видео в Промо).
   */
  mediaAspect?: CoverAspect
  /** Заполнить родителя целиком вместо собственной пропорции (ячейки мозаики). */
  fill?: boolean
  /** Кадр мастера: тот же мотив с другим кадрированием и светом. */
  frame?: number
  /** Длительность видео: подпись «▶ 13:24» слева снизу. */
  durationSeconds?: number
  /**
   * Состав, если длительности нет: «22 фото», у смешанного — «22 файла». Слова считает
   * приложение: у объекта из фото и видео «N фото» прятало бы видео.
   */
  countLabel?: string
  /** Число версий мастера: метка «v2» справа сверху, если версий больше одной. */
  versionCount?: number
  /** Подписи на обложке; в строках списка и крошечных миниатюрах их нет. */
  showCaptions?: boolean
  /** Дополнительные слои поверх обложки (знак, галочка выбора). */
  overlay?: ReactNode
  /** Размер растра обложки-заглушки: `screen` — для просмотра во весь экран. */
  resolution?: 'thumb' | 'screen'
  /**
   * Настоящая миниатюра (`/api/v1/<model>/g/<поколение>/thumb-640.webp`); пока её нет —
   * синтетическая обложка по `seed`. Грузится лениво, место держит `aspect-ratio`.
   */
  src?: string | null
}

/**
 * Миниатюра (DESIGN §7.6, §7.9): место держится заранее через `aspect-ratio`, обложка —
 * синтетическая сцена по ID. Подписи 11,5/14 на подложке `--scrim`.
 */
export function Thumb({
  seed,
  kind,
  family,
  aspect = '3:4',
  mediaAspect,
  fill = false,
  frame,
  durationSeconds,
  countLabel,
  versionCount,
  showCaptions = true,
  overlay,
  resolution,
  src,
  className,
  style,
  ...props
}: ThumbProps) {
  const resolvedFamily = family ?? pickCoverFamily(seed, kind)
  const contentAspect = mediaAspect ?? aspect
  const letterboxed = mediaAspect !== undefined && mediaAspect !== aspect
  const mediaIsWider = aspectRatioValue[contentAspect] > aspectRatioValue[aspect]

  return (
    <div
      data-slot="thumb"
      className={cn(
        'relative isolate overflow-hidden rounded-lg bg-muted',
        fill && 'size-full',
        className,
      )}
      style={fill ? style : { aspectRatio: aspectRatioValue[aspect], ...style }}
      {...props}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={cn(
            'absolute inset-0 size-full',
            letterboxed ? 'object-contain' : 'object-cover',
          )}
        />
      ) : letterboxed ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <CoverArt
            seed={seed}
            family={resolvedFamily}
            aspect={contentAspect}
            frame={frame}
            resolution={resolution}
            className={mediaIsWider ? 'h-auto w-full' : 'h-full w-auto'}
          />
        </div>
      ) : (
        <CoverArt
          seed={seed}
          family={resolvedFamily}
          aspect={contentAspect}
          frame={frame}
          resolution={resolution}
          className="absolute inset-0 size-full"
        />
      )}
      {showCaptions && versionCount !== undefined && versionCount > 1 ? (
        <CoverLabel className="top-1.5 right-1.5">
          <LayersIcon aria-hidden className="size-3" />v{versionCount}
        </CoverLabel>
      ) : null}
      {showCaptions ? (
        <MediaCaption durationSeconds={durationSeconds} countLabel={countLabel} />
      ) : null}
      {overlay}
    </div>
  )
}

function MediaCaption({
  durationSeconds,
  countLabel,
}: Pick<ThumbProps, 'durationSeconds' | 'countLabel'>) {
  if (durationSeconds !== undefined) {
    return (
      <CoverLabel className="bottom-1.5 left-1.5">
        <PlayIcon aria-hidden className="size-2.5 fill-current stroke-0" />
        <span className="sr-only">Длительность </span>
        {formatDuration(durationSeconds)}
      </CoverLabel>
    )
  }
  if (countLabel) {
    return <CoverLabel className="bottom-1.5 left-1.5">{countLabel}</CoverLabel>
  }
  return null
}

/** Подпись на обложке: 11,5/14 600 на `--scrim`, радиус 6 (§7.2, §7.4). */
export function CoverLabel({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'absolute inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-sm bg-scrim px-1.5 text-2xs text-scrim-foreground tabular-nums',
        className,
      )}
      {...props}
    />
  )
}
