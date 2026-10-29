import { type CatalogEntry, DOWNLOAD_KIND_LABEL, type DownloadKind } from '@contentops/contracts'
import type { DownloadOption } from '@contentops/ui/components/download-button'

/**
 * Варианты «Скачать ▾» для выбранных объектов (DESIGN §2.5, «Скачивания»): нажатие на
 * «Скачать» сразу даёт «Для заливки», остальное — в меню. Неприменимое не показывается.
 */
export function downloadOptionsFor(entries: readonly CatalogEntry[]): DownloadOption[] {
  const hasVideo = entries.some((entry) => entry.duration_s !== null)
  const hasPhotos = entries.some((entry) => (entry.photo_count ?? 0) > 0)
  const hasCustoms = entries.some((entry) => entry.type === 'custom')
  const kinds: { kind: DownloadKind; hint: string; show: boolean }[] = [
    { kind: 'platform', hint: 'копия для платформы', show: true },
    { kind: 'master', hint: 'исходное качество', show: hasVideo },
    { kind: 'compat', hint: 'соберётся по запросу', show: hasVideo },
    { kind: 'photos', hint: 'полный размер', show: hasPhotos },
    { kind: 'fan', hint: 'копия для покупателя', show: hasCustoms },
  ]
  return kinds
    .filter((option) => option.show)
    .map((option) => ({
      id: option.kind,
      label: DOWNLOAD_KIND_LABEL[option.kind],
      hint: option.hint,
    }))
}
