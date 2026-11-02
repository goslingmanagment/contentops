import { cn } from 'cn'
import { type ReactNode, useState } from 'react'
import { Button } from '../button'
import { aspectRatioValue } from '../cover/scene'
import { ProgressWord } from '../progress-word'
import { Thumb } from '../thumb'
import type { ViewerFile } from './viewer-file'

/** Пропорция места кадра: точная, если известна, иначе по виду кадра. */
export function frameRatio(file: ViewerFile): number {
  return file.ratio !== undefined && Number.isFinite(file.ratio) && file.ratio > 0
    ? file.ratio
    : aspectRatioValue[file.aspect]
}

/**
 * Место кадра по центру сцены, вписанное целиком: ширина — меньшее из ширины сцены и высоты,
 * умноженной на пропорцию (единицы контейнера сцены). Размер известен до загрузки, поэтому
 * пришедшие картинка и видео ничего не сдвигают (SPEC §12.0).
 */
export function MediaFrame({ file, children }: { file: ViewerFile; children: ReactNode }) {
  const ratio = frameRatio(file)
  return (
    <div
      data-slot="viewer-frame"
      className="relative overflow-hidden"
      style={{ aspectRatio: ratio, width: `min(100cqw, ${ratio} * 100cqh)` }}
    >
      {children}
    </div>
  )
}

/**
 * Картинка, которая проявляется за 120 мс, когда пришла из сети, и сразу — из кэша, без
 * мигания (DESIGN §3.10).
 */
function FadeImage({
  src,
  onFailed,
  className,
}: {
  src: string
  onFailed?: () => void
  className?: string
}) {
  const [shown, setShown] = useState<'no' | 'fade' | 'at-once'>('no')
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      ref={(image) => {
        if (image?.complete && image.naturalWidth > 0 && shown === 'no') {
          setShown('at-once')
        }
      }}
      onLoad={() => setShown((current) => (current === 'no' ? 'fade' : current))}
      onError={onFailed}
      className={cn(
        'absolute inset-0 size-full object-contain',
        shown === 'no' && 'opacity-0',
        shown === 'fade' && 'opacity-100 transition-opacity duration-120',
        className,
      )}
    />
  )
}

/**
 * Неподвижная картинка файла под всем остальным: постер или миниатюра — они обычно уже в
 * кэше от сетки; картинки нет — серое место. Рисованная сцена — только у заглушки разработки.
 */
export function MediaStill({ file }: { file: ViewerFile }) {
  const still = file.poster ?? file.thumb ?? null
  if (still) {
    return <FadeImage key={still} src={still} />
  }
  return (
    <Thumb
      fill
      seed={file.seed}
      kind={file.kind}
      family={file.family}
      aspect={file.aspect}
      showCaptions={false}
      resolution="screen"
      className="absolute inset-0 rounded-none bg-muted"
    />
  )
}

/** Фото в просмотре: миниатюра сразу, превью 2048 поверх, когда придёт. */
export function ViewerPhoto({ file, onFailed }: { file: ViewerFile; onFailed: () => void }) {
  return (
    <>
      <MediaStill file={file} />
      {file.src ? <FadeImage key={file.src} src={file.src} onFailed={onFailed} /> : null}
    </>
  )
}

interface MediaNoticeProps {
  file: ViewerFile
  /** Ход сборки 0–100 от страницы объекта (мастер ещё обрабатывается). */
  progress?: number
  failed: boolean
  onRetry: () => void
}

/**
 * Состояние поверх кадра (DESIGN §3.5, §3.10): «Превью собирается · 40 %», пока превью
 * нет; «Превью нет», если и не собирается; «Не загрузилось · Повторить» при ошибке сети.
 */
export function MediaNotice({ file, progress, failed, onRetry }: MediaNoticeProps) {
  const share =
    progress !== undefined
      ? progress
      : file.building?.progress === null || file.building?.progress === undefined
        ? null
        : file.building.progress * 100
  let content: ReactNode = null
  if (failed) {
    content = (
      <p className="flex items-center gap-2 text-base text-foreground">
        Не загрузилось
        <Button variant="bar" size="sm" onClick={onRetry}>
          Повторить
        </Button>
      </p>
    )
  } else if (progress !== undefined || (file.src === null && file.building)) {
    content =
      share === null ? (
        <p className="text-base text-foreground">Превью собирается</p>
      ) : (
        <ProgressWord label="Превью собирается ·" value={share} className="w-56 text-foreground" />
      )
  } else if (file.src === null) {
    content = <p className="text-base text-foreground">Превью нет</p>
  }
  if (content === null) {
    return null
  }
  return <div className="absolute inset-0 flex items-center justify-center bg-scrim">{content}</div>
}
