import { aspectRatioValue } from '../cover/scene'
import { Thumb } from '../thumb'
import type { ViewerFile } from './viewer-file'

/**
 * Кадр по центру сцены, вписанный целиком: ширина — меньшее из ширины сцены и высоты,
 * умноженной на пропорцию (единицы контейнера сцены).
 */
export function ViewerMedia({ file, frame }: { file: ViewerFile; frame?: number }) {
  const ratio = aspectRatioValue[file.aspect]
  return (
    <Thumb
      seed={file.seed}
      kind={file.kind}
      family={file.family}
      aspect={file.aspect}
      frame={frame}
      showCaptions={false}
      resolution="screen"
      className="rounded-none bg-transparent"
      style={{ width: `min(100cqw, ${ratio} * 100cqh)` }}
    />
  )
}
