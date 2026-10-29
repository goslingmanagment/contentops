import { addDays, instantMs, mskDate, mskTime, weekdayIndex } from './clock'
import type { Gender, Instant, LocalDate } from './domain/common'

/**
 * Russian formatting shared by the server phrases and the screens.
 * Numbers use a no-break space between thousands and a comma for decimals.
 */

const NBSP = ' '

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const

const WEEKDAYS = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
] as const
const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const

/** Picks the Russian plural form: `plural(3, ['день', 'дня', 'дней'])` → «дня». */
export function plural(count: number, forms: readonly [string, string, string]): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

export function formatNumber(value: number): string {
  const [whole, fraction] = String(Math.abs(value)).split('.')
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  const sign = value < 0 ? '−' : ''
  return fraction ? `${sign}${grouped},${fraction}` : `${sign}${grouped}`
}

function formatDecimal(value: number, digits: number): string {
  return formatNumber(Number(value.toFixed(digits)))
}

/** `13:24`, `0:09`, `1:02:03`. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** «пропущено» → «Пропущено»: первая буква заглавная, остальное как есть. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** «Заказ уже закрыт» → «заказ уже закрыт»: для середины фразы. */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** «11 ч», «2 ч 10 мин», «30 ч» — total running time of a folder or a selection. */
export function formatHoursMinutes(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} мин`
  return minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`
}

/** `58 МБ`, `1,9 ГБ`, `2,65 ГБ`. */
export function formatBytes(bytes: number): string {
  const megabytes = bytes / 1_000_000
  if (megabytes < 1) return `${Math.max(1, Math.round(bytes / 1000))} КБ`
  if (megabytes < 1000) return `${formatDecimal(megabytes, megabytes < 10 ? 1 : 0)} МБ`
  const gigabytes = megabytes / 1000
  if (gigabytes < 1000) return `${formatDecimal(gigabytes, gigabytes < 10 ? 2 : 1)} ГБ`
  return `${formatDecimal(gigabytes / 1000, 2)} ТБ`
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}${NBSP}%`
}

const sameYear = (date: LocalDate, today: LocalDate) => date.slice(0, 4) === today.slice(0, 4)

/**
 * Одно правило дат на всё приложение: дата текущего года — «22.09», другого года —
 * «22.09.2025». `today` — сегодняшний день по Москве (`mskDate(clock.now())`).
 */
export function formatDate(date: LocalDate, today: LocalDate): string {
  const dayMonth = `${date.slice(8, 10)}.${date.slice(5, 7)}`
  return sameYear(date, today) ? dayMonth : `${dayMonth}.${date.slice(0, 4)}`
}

/** «22 сентября» — день месяца словами, без года. Для дней рядом с сегодня: план, лента. */
export function formatDayMonthWords(date: LocalDate): string {
  const month = MONTHS_GENITIVE[Number(date.slice(5, 7)) - 1] ?? ''
  return `${Number(date.slice(8, 10))} ${month}`
}

/** То же правило словами: «6 августа», в другом году — «6 августа 2025». */
export function formatDateWords(date: LocalDate, today: LocalDate): string {
  const words = formatDayMonthWords(date)
  return sameYear(date, today) ? words : `${words} ${date.slice(0, 4)}`
}

/** «Вторник, 22 сентября». */
export function formatLongDay(date: LocalDate): string {
  const weekday = WEEKDAYS[weekdayIndex(date)] ?? ''
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${formatDayMonthWords(date)}`
}

/** «ср 23». */
export function formatShortDay(date: LocalDate): string {
  return `${WEEKDAYS_SHORT[weekdayIndex(date)] ?? ''} ${Number(date.slice(8, 10))}`
}

/** «вт», «ср». */
export function formatWeekdayShort(date: LocalDate): string {
  return WEEKDAYS_SHORT[weekdayIndex(date)] ?? ''
}

/** Moscow wall time of an instant: `13:52`. */
export function formatClock(instant: Instant): string {
  return mskTime(instant)
}

/** «сегодня 11:02», «вчера 22:10», «20.09 18:00», «20.09.2025 18:00». */
export function formatWhen(instant: Instant, now: Instant): string {
  const date = mskDate(instant)
  const today = mskDate(now)
  if (date === today) return `сегодня ${mskTime(instant)}`
  if (date === addDays(today, -1)) return `вчера ${mskTime(instant)}`
  return `${formatDate(date, today)} ${mskTime(instant)}`
}

/** «1 ч 20 мин», «8 мин», «3 дня». */
export function formatSpan(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes))
  if (whole < 60) return `${whole} мин`
  if (whole < 48 * 60) {
    const hours = Math.floor(whole / 60)
    const rest = whole % 60
    return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`
  }
  const days = Math.floor(whole / (24 * 60))
  return `${days} ${plural(days, ['день', 'дня', 'дней'])}`
}

export function minutesBetween(from: Instant, to: Instant): number {
  return (instantMs(to) - instantMs(from)) / 60_000
}

/** «4 мин назад», «2 ч назад», «только что». */
export function formatAgo(past: Instant, now: Instant): string {
  const minutes = minutesBetween(past, now)
  if (minutes < 1) return 'только что'
  return `${formatSpan(minutes)} назад`
}

/**
 * Russian past tense agrees with the actor: «поставил» → «поставила».
 * Works for the regular verbs the product uses (принял, отметил, связал, выключил…).
 */
export function pastVerb(masculine: string, gender: Gender | null): string {
  return gender === 'f' ? `${masculine}а` : masculine
}

/**
 * «9 дней», «3 месяца», «год», «полтора года», «2 года» — a span of days in words, as a
 * person says it: 15.03.2025 at 22.09.2026 is «полтора года», not «2 года».
 */
export function formatDaysSpan(days: number): string {
  const whole = Math.max(0, Math.round(days))
  if (whole < 60) return `${whole} ${plural(whole, ['день', 'дня', 'дней'])}`
  if (whole < 335) {
    const months = Math.round(whole / 30.4)
    return `${months} ${plural(months, ['месяц', 'месяца', 'месяцев'])}`
  }
  const years = whole / 365.25
  if (years < 1.25) return 'год'
  if (years < 1.75) return 'полтора года'
  const rounded = Math.round(years)
  return `${rounded} ${plural(rounded, ['год', 'года', 'лет'])}`
}

/** «сегодня», «вчера», «41 день назад», «год назад». */
export function formatDaysAgo(days: number): string {
  if (days <= 0) return 'сегодня'
  if (days === 1) return 'вчера'
  return `${formatDaysSpan(days)} назад`
}
