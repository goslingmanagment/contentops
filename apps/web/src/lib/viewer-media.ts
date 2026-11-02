import type { MediaPreview, ThumbRef } from '@contentops/contracts'
import type { ViewerFile } from '@contentops/ui/components/viewer'

/**
 * Настоящие адреса файла для просмотра (SPEC §9.3): миниатюра, превью, постер и сборка. У
 * заглушки разработки превью нет — тогда только миниатюра, а сцену рисует сама заглушка.
 */
export function viewerMedia(
  thumb: Pick<ThumbRef, 'url'> | null | undefined,
  preview: MediaPreview | undefined,
): Pick<ViewerFile, 'thumb' | 'src' | 'poster' | 'building'> {
  const still = thumb?.url ?? null
  if (!preview) {
    return { thumb: still }
  }
  return { thumb: still, src: preview.url, poster: preview.poster, building: preview.building }
}
