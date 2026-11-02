import type { CoverAspect, CoverFamily, CoverKind } from '../thumb'

/** Кадр видео с моментом: ленты сравнения версий (DESIGN §3.5). */
export interface ViewerFrame {
  seconds: number
  src: string | null
}

/** Файл в просмотре: мастер, тизер, фото сета, кадр лайфа. */
export interface ViewerFile {
  /** ID файла или объекта: от него рисованная обложка заглушки разработки. */
  seed: string
  type: 'video' | 'photo'
  aspect: CoverAspect
  /** Точная пропорция кадра (ширина / высота), если известна: по ней держится место. */
  ratio?: number
  kind?: CoverKind
  family?: CoverFamily
  durationSeconds?: number
  /** Подпись в ленте: номер фото или «тизер». */
  label?: string
  /** Миниатюра `thumb-640.webp`: лента кадров и картинка, пока большое не пришло. */
  thumb?: string | null
  /**
   * Что смотреть (SPEC §9.3): `preview.mp4` у видео, `preview-2048.webp` у фото; мастер в
   * браузере не открывается. `null` — превью ещё нет; не задано — у заглушки нет байтов.
   */
  src?: string | null
  /** Постер видео `poster.webp`: первый кадр, пока видео не загрузилось. */
  poster?: string | null
  /** Превью собирается: доля 0–1 или `null`, если она неизвестна. */
  building?: { progress: number | null } | null
  /** Кадры видео на общих таймкодах версий: n-е кадры двух версий — один момент. */
  frames?: readonly ViewerFrame[]
}
