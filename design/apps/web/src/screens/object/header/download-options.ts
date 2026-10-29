import {
  DOWNLOAD_KIND_LABEL,
  type DownloadKind,
  deliveryOf,
  downloadFileName,
  fanFileName,
  formatBytes,
  formatNumber,
  type ItemDetail,
  type ItemFile,
} from '@contentops/contracts'
import type { DownloadOption } from '@contentops/ui/components/download-button'

/**
 * «Скачать ▾» объекта (DESIGN §4.4): нажатие на «Скачать» отдаёт «Для заливки», в меню —
 * только то, что есть у этого объекта. Пока мастер собирается, есть только «Исходник».
 * Будущее имя файла — в подсказке пункта.
 */

/** Копия для платформы у коротких видео готова сразу, длинная собирается по нажатию. */
const READY_COPY_SECONDS = 60

function mainVideo(detail: ItemDetail): ItemFile | undefined {
  return detail.files.find((file) => file.role === 'master' || file.role === 'montage')
}

function option(
  detail: ItemDetail,
  kind: DownloadKind,
  hint: string,
  model: string,
  label: string = DOWNLOAD_KIND_LABEL[kind],
): DownloadOption {
  return {
    id: kind,
    label,
    hint,
    fileName: downloadFileName(detail.entry, detail.files, kind, { model }),
  }
}

/** Что отдаст «Для заливки»: у сета — отобранные кадры, у лайфа — кадры с назначением. */
function platformHint(detail: ItemDetail, video: ItemFile | undefined): string {
  const { entry } = detail
  if (!video) {
    const count = formatNumber(deliveryOf(entry, detail.files, 'platform').files.length)
    if (entry.type === 'set') {
      return entry.selected_count
        ? `отобранные кадры по порядку · ${count}`
        : `кадры не отобраны — все по съёмке · ${count}`
    }
    if (entry.type === 'life') return `кадры с назначением по порядку · ${count}`
    return `файлы по порядку · ${count}`
  }
  const ready = entry.type === 'fyp' || (video.duration_s ?? 0) < READY_COPY_SECONDS
  return ready ? 'копия для платформы · готова' : 'копия для платформы · соберётся'
}

export function objectDownloadOptions(detail: ItemDetail, model: string): DownloadOption[] {
  // Подборку промо отдают передачей подрядчику, а не скачиванием.
  if (detail.entry.type === 'promo') {
    return []
  }
  const video = mainVideo(detail)
  if (video?.state.kind === 'processing') {
    return [option(detail, 'source', 'до готовности мастера', model)]
  }
  const photos = detail.files.filter((file) => file.media === 'photo').length
  const options: DownloadOption[] = []
  if (detail.entry.type !== 'raw') {
    options.push(option(detail, 'platform', platformHint(detail, video), model))
  }
  if (video) {
    const size = `${formatBytes(video.size_bytes)} · ${video.width} × ${video.height}`
    options.push(option(detail, 'master', `${size} · CapCut открывает`, model))
    options.push(option(detail, 'compat', 'соберётся по запросу, не хранится', model))
  }
  if (photos > 0) {
    const label = `${DOWNLOAD_KIND_LABEL.photos} · ${formatNumber(photos)}`
    options.push(option(detail, 'photos', 'исходники фото', model, label))
  }
  if (detail.entry.type === 'custom' && !detail.entry.photo_custom) {
    options.push(option(detail, 'fan', fanFileName(model), model))
  }
  if (detail.entry.type === 'raw') {
    const label = `Файлы съёмки · ${formatNumber(detail.files.length)}`
    options.unshift(option(detail, 'source', 'как сняты', model, label))
  }
  return options
}
