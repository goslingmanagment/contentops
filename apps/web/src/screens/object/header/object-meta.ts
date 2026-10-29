import {
  type CatalogEntry,
  FAN_NAME_LABEL,
  formatBytes,
  formatDate,
  formatDateWords,
  formatDuration,
  formatNumber,
  type ItemDetail,
  type ItemType,
  type LocalDate,
  plural,
  RAW_PURPOSE_LABEL,
  vaultAlbumName,
} from '@contentops/contracts'

/**
 * Мета-строка объекта (DESIGN §4.5): только то, что есть, словами через точку. У каждого
 * типа своя строка: «Бандл на стену · 13:24 · 21 фото · тизер 0:32 · снято 6 августа».
 * До ответа сервера строка собирается из записи каталога: то, что знает только карточка
 * (тизер, альбом, съёмка фупа), дописывается, когда она придёт.
 */

type MetaParts = (
  entry: CatalogEntry,
  detail: ItemDetail | null,
  today: LocalDate,
) => (string | null)[]

function count(value: number | null, forms: readonly [string, string, string]): string | null {
  return value ? `${formatNumber(value)} ${plural(value, forms)}` : null
}

const PHOTOS = ['фото', 'фото', 'фото'] as const
const VIDEOS = ['видео', 'видео', 'видео'] as const

function duration(entry: CatalogEntry): string | null {
  return entry.duration_s === null ? null : formatDuration(entry.duration_s)
}

function teaser(detail: ItemDetail | null): string | null {
  const file = detail?.files.find((candidate) => candidate.role === 'teaser')
  if (!file) {
    return null
  }
  return file.duration_s === null ? 'тизер' : `тизер ${formatDuration(file.duration_s)}`
}

/** Альбом vault по норме или старое имя, как оно стоит на платформе. */
function vaultAlbum(detail: ItemDetail | null): string | null {
  if (!detail) {
    return null
  }
  const album = detail.pages
    .flatMap((page) => page.surfaces)
    .find((surface) => surface.surface === 'vault' && surface.album)?.album
  return `альбом vault «${album ?? vaultAlbumName(detail.entry)}»`
}

const SHOOT_PREFIX = 'Съёмка '

/** «из съёмки 6 августа»: сырьё, из которого сделан фуп. */
function fromShoot(detail: ItemDetail | null, today: LocalDate): string | null {
  if (!detail) {
    return null
  }
  const shoot = detail.provenance.find(
    (link) => link.direction === 'out' && link.item_type === 'raw',
  )
  if (shoot) {
    return shoot.item_title.startsWith(SHOOT_PREFIX)
      ? `из съёмки ${shoot.item_title.slice(SHOOT_PREFIX.length)}`
      : `из ${shoot.item_id}`
  }
  return detail.entry.shot_on ? `снят ${formatDate(detail.entry.shot_on, today)}` : null
}

function mediaCount(
  entry: CatalogEntry,
  detail: ItemDetail | null,
  media: 'photo' | 'video',
): number | null {
  if (detail) {
    return detail.files.filter((file) => file.media === media).length
  }
  return media === 'photo' ? entry.photo_count : entry.video_count
}

const META_BY_TYPE: Record<ItemType, MetaParts> = {
  ppv: (entry, detail, today) => [
    entry.ppv_kind === 'dm' ? 'В личку' : 'Бандл на стену',
    duration(entry),
    count(entry.photo_count, PHOTOS),
    teaser(detail),
    entry.shot_on ? `снято ${formatDateWords(entry.shot_on, today)}` : null,
  ],
  custom: (entry, _detail, today) => [
    entry.photo_custom ? 'Фото-кастом' : 'Кастом',
    duration(entry) ?? count(entry.photo_count, PHOTOS),
    entry.delivered_on ? `сдан ${formatDate(entry.delivered_on, today)}` : null,
    entry.fan_name ? FAN_NAME_LABEL[entry.fan_name] : null,
  ],
  set: (entry, _detail, today) => [
    'Сет',
    count(entry.photo_count, ['кадр', 'кадра', 'кадров']),
    entry.selected_count === null ? null : `отобрано ${formatNumber(entry.selected_count)}`,
    entry.processed_count ? `обработано ${formatNumber(entry.processed_count)}` : null,
    `снят ${formatDate(entry.shot_on ?? entry.arrived_on, today)}`,
  ],
  sexting: (entry, detail) => [
    'Секстинг',
    count(entry.photo_count, PHOTOS),
    count(entry.video_count, VIDEOS),
    vaultAlbum(detail),
  ],
  fyp: (entry, detail, today) => ['Фуп', duration(entry), fromShoot(detail, today)],
  life: (entry, _detail, today) => [
    'Лайф',
    count(entry.photo_count, PHOTOS),
    count(entry.video_count, VIDEOS),
    formatDate(entry.shot_on ?? entry.arrived_on, today),
    entry.life_unassigned ? `без назначения ${formatNumber(entry.life_unassigned)}` : null,
  ],
  raw: (entry, detail, today) => [
    entry.shot_on ? `Съёмка ${formatDateWords(entry.shot_on, today)}` : 'Съёмка',
    count(detail ? detail.files.length : (entry.photo_count ?? 0) + (entry.video_count ?? 0), [
      'файл',
      'файла',
      'файлов',
    ]),
    entry.raw_purpose ? `назначение: ${RAW_PURPOSE_LABEL[entry.raw_purpose]}` : null,
  ],
  promo: (entry, detail) => [
    'Подборка',
    count(mediaCount(entry, detail, 'video'), VIDEOS),
    count(mediaCount(entry, detail, 'photo'), PHOTOS),
    entry.size_bytes ? formatBytes(entry.size_bytes) : null,
  ],
}

function metaParts(entry: CatalogEntry, detail: ItemDetail | null, today: LocalDate): string[] {
  const parts = META_BY_TYPE[entry.type](entry, detail, today)
  if (entry.second_person) {
    parts.push('второй человек в кадре')
  }
  return parts.filter((part): part is string => part !== null)
}

/** Части мета-строки по порядку; «второй человек в кадре» — только когда он есть. */
export function objectMetaParts(detail: ItemDetail, today: LocalDate): string[] {
  return metaParts(detail.entry, detail, today)
}

/** Мета-строка по записи каталога — пока карточка объекта не пришла. */
export function entryMetaParts(entry: CatalogEntry, today: LocalDate): string[] {
  return metaParts(entry, null, today)
}
