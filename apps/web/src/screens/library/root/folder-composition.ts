import { type CatalogEntry, formatNumber, type ItemType, plural } from '@contentops/contracts'

/**
 * Строка состава папки (DESIGN §4.1): что внутри, одной строкой и без открытия.
 * «52 бандла · 38 в личку · 11 ч», «197 · 30 ч · в PPV 38», «73 · ≈1 965 кадров».
 * Нулевые уточнения не пишутся: «0 от SteadyContent» ничего не говорит.
 */

type Forms = readonly [string, string, string]

function counted(count: number, forms: Forms): string {
  return `${formatNumber(count)} ${plural(count, forms)}`
}

function sum(
  entries: readonly CatalogEntry[],
  pick: (entry: CatalogEntry) => number | null,
): number {
  return entries.reduce((total, entry) => total + (pick(entry) ?? 0), 0)
}

/** «11 ч»: суммарная длительность, округлённая до часа (меньше часа — минуты). */
function totalHours(entries: readonly CatalogEntry[]): string {
  const seconds = sum(entries, (entry) => entry.duration_s)
  const hours = Math.round(seconds / 3600)
  return hours > 0 ? `${formatNumber(hours)} ч` : `${formatNumber(Math.round(seconds / 60))} мин`
}

const COMPOSERS: Record<ItemType, (entries: readonly CatalogEntry[]) => string> = {
  ppv: (entries) => {
    const bundles = entries.filter((entry) => entry.ppv_kind === 'bundle').length
    const direct = entries.filter((entry) => entry.ppv_kind === 'dm').length
    const kinds = [
      bundles > 0 ? counted(bundles, ['бандл', 'бандла', 'бандлов']) : null,
      direct > 0 ? `${formatNumber(direct)} в личку` : null,
    ].filter((part) => part !== null)
    const head = kinds.length > 0 ? kinds : [formatNumber(entries.length)]
    return [...head, totalHours(entries)].join(' · ')
  },
  fyp: (entries) => {
    const steady = entries.filter((entry) => entry.steady_content).length
    const total = formatNumber(entries.length)
    return steady > 0 ? `${total} · ${formatNumber(steady)} от SteadyContent` : total
  },
  custom: (entries) => {
    const inPpv = entries.filter((entry) => entry.ppv_made_as !== null).length
    const head = `${formatNumber(entries.length)} · ${totalHours(entries)}`
    return inPpv > 0 ? `${head} · в PPV ${formatNumber(inPpv)}` : head
  },
  set: (entries) => {
    const frames = sum(entries, (entry) => entry.photo_count)
    return `${formatNumber(entries.length)} · ≈${counted(frames, ['кадр', 'кадра', 'кадров'])}`
  },
  sexting: (entries) => {
    const files = sum(entries, (entry) => (entry.photo_count ?? 0) + (entry.video_count ?? 0))
    return `${formatNumber(entries.length)} · ${counted(files, ['файл', 'файла', 'файлов'])}`
  },
  life: (entries) => {
    const photos = sum(entries, (entry) => entry.photo_count)
    return `${formatNumber(entries.length)} · ${formatNumber(photos)} фото`
  },
  raw: (entries) => {
    const files = sum(entries, (entry) => (entry.photo_count ?? 0) + (entry.video_count ?? 0))
    return `${counted(entries.length, ['съёмка', 'съёмки', 'съёмок'])} · ${counted(files, ['файл', 'файла', 'файлов'])}`
  },
  promo: (entries) => {
    const channels = new Set(entries.map((entry) => entry.channel).filter(Boolean)).size
    return `${counted(entries.length, ['подборка', 'подборки', 'подборок'])} · ${counted(channels, ['канал', 'канала', 'каналов'])}`
  },
}

export function folderComposition(type: ItemType, entries: readonly CatalogEntry[]): string {
  return entries.length === 0 ? 'пока нет' : COMPOSERS[type](entries)
}

/** «по 5 страницам» — папка «Ещё не залито». */
export function notUploadedComposition(pageCount: number): string {
  return `по ${counted(pageCount, ['странице', 'страницам', 'страницам'])}`
}
