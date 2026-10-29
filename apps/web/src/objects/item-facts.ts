import {
  type CatalogEntry,
  formatDuration,
  formatHoursMinutes,
  formatNumber,
  ITEM_TYPE_INFO,
  type ItemType,
  PPV_KIND_LABEL,
  plural,
} from '@contentops/contracts'
import { compositionText } from '@/lib/words'

/**
 * «13:24» у видео, «22 фото» у фото-объектов, «10 фото · 12 видео» у смешанного, «—», если
 * нет ни того, ни другого.
 */
export function lengthText(entry: CatalogEntry): string {
  if (entry.duration_s !== null) {
    return formatDuration(entry.duration_s)
  }
  return compositionText(entry) ?? '—'
}

/** Мета-строка быстрого взгляда: «Бандл · 13:24 · 21 фото · тизер». */
export function metaLine(entry: CatalogEntry): string {
  const parts: string[] = []
  if (entry.ppv_kind) {
    const kind = PPV_KIND_LABEL[entry.ppv_kind]
    parts.push(kind.charAt(0).toUpperCase() + kind.slice(1))
  } else {
    parts.push(ITEM_TYPE_INFO[entry.type].folder)
  }
  if (entry.duration_s !== null) {
    parts.push(formatDuration(entry.duration_s))
  }
  // У видео с длительностью лишние клипы — не состав; у остальных видео видно рядом с фото.
  const composition =
    entry.duration_s !== null
      ? entry.photo_count
        ? `${formatNumber(entry.photo_count)} фото`
        : null
      : compositionText(entry)
  if (composition) {
    parts.push(composition)
  }
  if (entry.has_teaser) {
    parts.push('тизер')
  }
  return parts.join(' · ')
}

const TYPE_FORMS: Record<ItemType, readonly [string, string, string]> = {
  ppv: ['PPV', 'PPV', 'PPV'],
  fyp: ['фуп', 'фупа', 'фупов'],
  custom: ['кастом', 'кастома', 'кастомов'],
  set: ['сет', 'сета', 'сетов'],
  sexting: ['секстинг', 'секстинга', 'секстингов'],
  life: ['лайф', 'лайфа', 'лайфов'],
  raw: ['съёмка', 'съёмки', 'съёмок'],
  promo: ['подборка', 'подборки', 'подборок'],
}

/** «Выбрано 7 · 3 PPV, 4 сета · 2 ч 10 мин · 146 фото» (DESIGN §3.4). */
export function selectionSummary(entries: readonly CatalogEntry[]): string {
  const byType = new Map<ItemType, number>()
  for (const entry of entries) {
    byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1)
  }
  const types = [...byType.entries()]
    .map(([type, count]) => `${formatNumber(count)} ${plural(count, TYPE_FORMS[type])}`)
    .join(', ')
  const seconds = entries.reduce((sum, entry) => sum + (entry.duration_s ?? 0), 0)
  const photos = entries.reduce((sum, entry) => sum + (entry.photo_count ?? 0), 0)
  const parts = [`Выбрано ${formatNumber(entries.length)}`, types]
  if (seconds > 0) {
    parts.push(formatHoursMinutes(seconds))
  }
  if (photos > 0) {
    parts.push(`${formatNumber(photos)} фото`)
  }
  return parts.join(' · ')
}
