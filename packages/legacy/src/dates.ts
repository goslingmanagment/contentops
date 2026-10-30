import type { LegacyDate } from './types.ts'

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

function daysIn(month: number, year: number | null): number {
  if (month === 2) return year === null || (year % 4 === 0 && year % 100 !== 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Two-digit years are 20YY; four-digit ones must be 2000–2099. */
export function fullYear(text: string): number | null {
  const n = Number(text)
  if (text.length === 2) return 2000 + n
  if (text.length === 4 && n >= 2000 && n <= 2099) return n
  return null
}

export function makeDate(
  year: number | null,
  month: number,
  day: number | null,
): LegacyDate | null {
  if (month < 1 || month > 12) return null
  if (day !== null && (day < 1 || day > daysIn(month, year))) return null
  let iso: string
  if (day === null) iso = year === null ? `--${pad(month)}` : `${year}-${pad(month)}`
  else iso = year === null ? `--${pad(month)}-${pad(day)}` : `${year}-${pad(month)}-${pad(day)}`
  return { year, month, day, iso }
}

export function yearDate(year: number): LegacyDate {
  return { year, month: null, day: null, iso: String(year) }
}

/** `04.08.26`, `4.08.2026`, `28.07`, `18.03,26` → a date, or `null` when it is not one. */
export function dayMonthYear(day: string, month: string, year?: string): LegacyDate | null {
  const y = year === undefined ? null : fullYear(year)
  if (year !== undefined && y === null) return null
  return makeDate(y, Number(month), Number(day))
}

const MONTHS: readonly [RegExp, number][] = [
  [/^(jan(uary)?|январ[ьяе]|янв)$/i, 1],
  [/^(feb(ruary)?|феврал[ьяе]|фев)$/i, 2],
  [/^(mar(ch)?|март[ае]?|мар)$/i, 3],
  [/^(apr(il)?|апрел[ьяе]|апр)$/i, 4],
  [/^(may|ма[йяе])$/i, 5],
  [/^(june?|июн[ьяе])$/i, 6],
  [/^(july?|июл[ьяе])$/i, 7],
  [/^(aug(ust)?|август[ае]?|авг)$/i, 8],
  [/^(sep(t(ember)?)?|сентябр[ьяе]|сен)$/i, 9],
  [/^(oct(ober)?|октябр[ьяе]|окт)$/i, 10],
  [/^(nov(ember)?|ноябр[ьяе]|ноя)$/i, 11],
  [/^(dec(ember)?|декабр[ьяе]|дек)$/i, 12],
]

/** Month words of the old disk: `August`, `Апрель`, `июнь`, `Sept`. */
export function monthOf(word: string): number | null {
  for (const [pattern, month] of MONTHS) if (pattern.test(word)) return month
  return null
}

/** Alternation of all month words for building token patterns. */
export const MONTH_WORD =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|январ[ьяе]|феврал[ьяе]|март[ае]?|апрел[ьяе]|ма[йяе]|июн[ьяе]|июл[ьяе]|август[ае]?|сентябр[ьяе]|октябр[ьяе]|ноябр[ьяе]|декабр[ьяе])'
