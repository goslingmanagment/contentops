import type { Instant, IsoWeek, LocalDate, LocalTime } from './domain/common'

/** Moscow has no daylight saving time since 2014: always UTC+3. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export function instantMs(instant: Instant): number {
  return Date.parse(instant)
}

export function instantFromMs(ms: number): Instant {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** `mskInstant('2026-09-22', '14:20')` → `2026-09-22T11:20:00Z`. */
export function mskInstant(date: LocalDate, time: LocalTime = '00:00'): Instant {
  return instantFromMs(Date.parse(`${date}T${time}:00Z`) - MSK_OFFSET_MS)
}

function mskShifted(instant: Instant): Date {
  return new Date(instantMs(instant) + MSK_OFFSET_MS)
}

export function mskDate(instant: Instant): LocalDate {
  return mskShifted(instant).toISOString().slice(0, 10)
}

export function mskTime(instant: Instant): LocalTime {
  return mskShifted(instant).toISOString().slice(11, 16)
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  return instantFromMs(instantMs(instant) + minutes * 60_000)
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(date: LocalDate): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
}

export function isoWeekOf(date: LocalDate): IsoWeek {
  const thursday = addDays(date, 3 - weekdayIndex(date))
  const year = Number(thursday.slice(0, 4))
  const week = Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

export function weekStart(week: IsoWeek): LocalDate {
  const year = Number(week.slice(0, 4))
  const weekNumber = Number(week.slice(6))
  const januaryFourth: LocalDate = `${year}-01-04`
  const firstMonday = addDays(januaryFourth, -weekdayIndex(januaryFourth))
  return addDays(firstMonday, (weekNumber - 1) * 7)
}

export function weekDates(week: IsoWeek): LocalDate[] {
  const monday = weekStart(week)
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index))
}

/**
 * «Сейчас»: everything that depends on the current moment takes it from a clock. The product
 * runs on `systemClock`, the mock on its prototype clock, tests pass a frozen one.
 */
export interface Clock {
  now(): Instant
}

export const systemClock: Clock = { now: () => instantFromMs(Date.now()) }

export function createFrozenClock(at: Instant): Clock {
  return { now: () => at }
}
