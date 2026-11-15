import { formatNumber, formatPercent, type StatsDays } from '@contentops/contracts'

/** Периоды «Статистики»: дни Fansly по UTC, как их считает Hub. */
export const DAYS_CHOICES: readonly { value: `${StatsDays}`; label: string; words: string }[] = [
  { value: '7', label: '7 дней', words: 'последние 7 дней' },
  { value: '30', label: '30 дней', words: 'последние 30 дней' },
  { value: '90', label: '90 дней', words: 'последние 90 дней' },
  { value: '180', label: 'Полгода', words: 'последние полгода' },
  { value: '365', label: 'Год', words: 'последний год' },
]

/** Откуда пришёл просмотр (0 For You, 1 лента подписок, 2 рекомендации, 3 поиск, 4 другое). */
const SOURCE_WORDS: Readonly<Record<number, string>> = {
  0: 'For You',
  1: 'Лента подписок',
  2: 'Рекомендации',
  3: 'Поиск',
  4: 'Другое',
}
/** Цвет принадлежит источнику, а не месту в списке. */
const SOURCE_TONES: Readonly<Record<number, string>> = {
  0: 'bg-primary',
  1: 'bg-primary/45',
  2: 'bg-attention',
  3: 'bg-ink-3',
  4: 'bg-line-strong',
}
const SOURCE_STROKES: Readonly<Record<number, string>> = {
  0: 'stroke-primary',
  1: 'stroke-primary/45',
  2: 'stroke-attention',
  3: 'stroke-ink-3',
  4: 'stroke-line-strong',
}

export const sourceWord = (source: number) => SOURCE_WORDS[source] ?? `Источник ${source}`
export const sourceTone = (source: number) => SOURCE_TONES[source] ?? 'bg-line-strong'
export const sourceStroke = (source: number) => SOURCE_STROKES[source] ?? 'stroke-line-strong'

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : formatNumber(value)
}

export function money(mills: number | null | undefined): string {
  return mills === null || mills === undefined ? '—' : `$${(mills / 1000).toFixed(2)}`
}

/** Досмотр: средняя доля видео, которую посмотрели (сумма долей в сотых процента ÷ просмотры видео). */
export function watchShare(watchPctSum: number | null, videoViews: number | null): number | null {
  if (watchPctSum === null || videoViews === null || videoViews === 0) return null
  return watchPctSum / videoViews / 10_000
}

export function share(part: number | null, whole: number | null): number | null {
  return part === null || whole === null || whole === 0 ? null : part / whole
}

export const percent = (fraction: number | null) =>
  fraction === null ? '—' : formatPercent(fraction)

/** «3 мин», «45 с». */
function length(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} с`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}

const DAY_MONTH = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Moscow',
})
export const dayWords = (instant: string) => DAY_MONTH.format(new Date(instant))
/** День Fansly (UTC, `2026-11-14`) словами: «14 нояб.». */
export const utcDayWords = (day: string) =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  )

interface Head {
  media_type: number | null
  duration_ms: number | null
  caption: string | null
  posted_at: string | null
  deleted_at: string | null
}

const CAPTION_LIMIT = 70

/** Текст поста до 70 знаков; без него — вид: «Видео без подписи». Номер — никогда. */
export function mediaTitle(head: Pick<Head, 'media_type' | 'caption'>): string {
  const caption = head.caption?.replace(/\s+/g, ' ').trim()
  if (caption)
    return caption.length > CAPTION_LIMIT
      ? `${caption.slice(0, CAPTION_LIMIT).trimEnd()}…`
      : caption
  return head.media_type === 2
    ? 'Видео без подписи'
    : head.media_type === 1
      ? 'Фото без подписи'
      : 'Медиа без подписи'
}

/** «видео · 3 мин · 18 окт. · удалено 3 нояб.» */
export function mediaLine(head: Head, posted = false): string {
  const kind =
    head.media_type === 2
      ? head.duration_ms
        ? `видео · ${length(head.duration_ms)}`
        : 'видео'
      : head.media_type === 1
        ? 'фото'
        : 'медиа'
  const parts = [kind]
  if (head.posted_at)
    parts.push(posted ? `вышло ${dayWords(head.posted_at)}` : dayWords(head.posted_at))
  if (head.deleted_at) parts.push(`удалено ${dayWords(head.deleted_at)}`)
  return parts.join(' · ')
}

export const fanslyPostUrl = (postId: string) =>
  `https://fansly.com/post/${encodeURIComponent(postId)}`

/** Почему экран пуст, словами. */
export function statsStateWords(state: string): string | null {
  switch (state) {
    case 'no_grant':
      return 'Статистика открывается с учётной записью из реестра людей. Попросите владельца.'
    case 'refused':
      return 'Вашей роли статистика не открыта. Попросите владельца.'
    case 'unreachable':
      return 'Статистика сейчас не загружается: обновите чуть позже.'
    case 'no_hub':
      return 'Статистика ещё не подключена.'
    default:
      return null
  }
}
