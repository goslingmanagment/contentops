import type { CoverAspect, CoverFamily, CoverKind } from '../thumb'

/** Файл в просмотре: мастер, тизер, фото сета, кадр лайфа. */
export interface ViewerFile {
  /** ID файла или объекта: от него обложка. */
  seed: string
  type: 'video' | 'photo'
  aspect: CoverAspect
  kind?: CoverKind
  family?: CoverFamily
  durationSeconds?: number
  /** Подпись в ленте: номер фото или «тизер». */
  label?: string
}
