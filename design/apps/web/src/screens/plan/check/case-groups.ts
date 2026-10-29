import {
  type Account,
  type AccountCode,
  type CheckCase,
  formatDayMonthWords,
  type IsoWeek,
  isoWeekOf,
  weekDates,
} from '@contentops/contracts'
import { isOpenCase } from '@/data/check'
import { caseMoment } from './case-text'

/** Очередь «Сверить» по страницам, как день плана (DESIGN §4.15): порядок страниц модели. */

export interface CaseFilter {
  page?: AccountCode
  week?: IsoWeek
}

export interface CaseGroup {
  account: Account
  cases: CheckCase[]
}

function momentKey(entry: CheckCase): string {
  const moment = caseMoment(entry)
  return moment ? `${moment.date} ${moment.time ?? '24:00'}` : ''
}

export function caseWeek(entry: CheckCase): IsoWeek | null {
  const moment = caseMoment(entry)
  return moment ? isoWeekOf(moment.date) : null
}

export function filterCases(cases: readonly CheckCase[], filter: CaseFilter): CheckCase[] {
  return cases.filter(
    (entry) =>
      (!filter.page || entry.account === filter.page) &&
      (!filter.week || caseWeek(entry) === filter.week),
  )
}

/** Группы по страницам; внутри — свежие сверху. Решённая строка остаётся на своём месте. */
export function groupByPage(cases: readonly CheckCase[], accounts: readonly Account[]) {
  return accounts
    .map(
      (account): CaseGroup => ({
        account,
        cases: cases
          .filter((entry) => entry.account === account.code)
          .sort((left, right) => momentKey(right).localeCompare(momentKey(left))),
      }),
    )
    .filter((group) => group.cases.length > 0)
}

/** «21–27 сентября», «28 сентября – 4 октября». */
export function weekLabel(week: IsoWeek): string {
  const dates = weekDates(week)
  const first = dates[0]
  const last = dates[6]
  if (!first || !last) {
    return week
  }
  if (first.slice(5, 7) === last.slice(5, 7)) {
    return `${Number(first.slice(8, 10))}–${formatDayMonthWords(last)}`
  }
  return `${formatDayMonthWords(first)} – ${formatDayMonthWords(last)}`
}

/** Недели, в которых есть случаи, новые первыми: варианты чипа «Неделя ▾». */
export function weekOptions(cases: readonly CheckCase[]) {
  const weeks = new Set<IsoWeek>()
  for (const entry of cases) {
    const week = caseWeek(entry)
    if (week) {
      weeks.add(week)
    }
  }
  return [...weeks]
    .sort((left, right) => right.localeCompare(left))
    .map((week) => ({ value: week, label: weekLabel(week) }))
}

/**
 * Куда встать после решения (DESIGN §7.8): следующий открытый случай по очереди, а если
 * ниже никого — ближайший выше. Никого не осталось — `null`.
 */
export function nextOpenCase(order: readonly CheckCase[], caseId: string): string | null {
  const index = order.findIndex((entry) => entry.id === caseId)
  const isOther = (entry: CheckCase) => entry.id !== caseId && isOpenCase(entry)
  const after = order.slice(index + 1).find(isOther)
  const before = order.slice(0, Math.max(index, 0)).reverse().find(isOther)
  return (after ?? before)?.id ?? null
}
