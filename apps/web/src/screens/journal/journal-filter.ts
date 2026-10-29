import {
  type ActorType,
  addDays,
  type Instant,
  instantFromMs,
  instantMs,
  JOURNAL_AREA_LABEL,
  type JournalArea,
  type JournalFilter,
  type JournalResult,
  mskDate,
  mskInstant,
  type Role,
} from '@contentops/contracts'
import type { FilterOption } from '@contentops/ui/components/filter-chips'
import type { JournalPeriod, JournalSearch } from './search'

/** Подписи чипов журнала (DESIGN §4.18): «Кто: люди / агенты / система». */
export const WHO_LABEL: Record<ActorType, string> = {
  person: 'люди',
  agent: 'агенты',
  system: 'система',
}

export const RESULT_LABEL: Record<JournalResult, string> = {
  ok: 'выполнено',
  denied: 'отказы',
  error: 'ошибки',
}

export const PERIOD_LABEL: Record<JournalPeriod, string> = {
  today: 'сегодня',
  yesterday: 'вчера',
  week: '7 дней',
  month: '30 дней',
}

function optionsOf<Key extends string>(labels: Record<Key, string>): FilterOption[] {
  return Object.entries<string>(labels).map(([value, label]) => ({ value, label }))
}

export const WHO_OPTIONS = optionsOf(WHO_LABEL)
export const RESULT_OPTIONS = optionsOf(RESULT_LABEL)
export const PERIOD_OPTIONS = optionsOf(PERIOD_LABEL)

/** «Только чтение» не видит заказов ни в карточках, ни в журнале (§4.18). */
export function areaOptions(role: Role | null): FilterOption[] {
  return optionsOf(JOURNAL_AREA_LABEL).filter(
    (option) => role !== 'reader' || option.value !== ('orders' satisfies JournalArea),
  )
}

/** Границы периода по московскому календарю: «вчера» — с полуночи до полуночи. */
function periodRange(period: JournalPeriod, now: Instant): Pick<JournalFilter, 'from' | 'to'> {
  const today = mskDate(now)
  const midnight = mskInstant(today)
  switch (period) {
    case 'today':
      return { from: midnight }
    case 'yesterday':
      return { from: mskInstant(addDays(today, -1)), to: instantFromMs(instantMs(midnight) - 1000) }
    case 'week':
      return { from: mskInstant(addDays(today, -6)) }
    case 'month':
      return { from: mskInstant(addDays(today, -29)) }
  }
}

/** Фильтры адреса → запрос `GET …/journal` (агент зовёт тот же путь). */
export function journalFilterOf(search: JournalSearch, now: Instant): JournalFilter {
  return {
    actor_type: search.who,
    area: search.what,
    item: search.item,
    result: search.result,
    ...(search.period ? periodRange(search.period, now) : {}),
  }
}

/** Параметры адреса, которые считаются фильтрами; `?demo=` и `?as=` сюда не входят. */
const FILTER_KEYS = [
  'who',
  'what',
  'item',
  'result',
  'period',
] as const satisfies readonly (keyof JournalSearch)[]

/** Фильтры одной строкой: по ней лента помнит раскрытое и прокрутку. */
export function journalFilterKey(search: JournalSearch): string {
  return FILTER_KEYS.map((key) => search[key] ?? '').join('|')
}

export function hasJournalFilters(search: JournalSearch): boolean {
  return FILTER_KEYS.some((key) => search[key] !== undefined)
}

/** «Сбросить»: все фильтры журнала выключены, остальной адрес на месте. */
export const NO_JOURNAL_FILTERS = {
  who: undefined,
  what: undefined,
  item: undefined,
  result: undefined,
  period: undefined,
} satisfies Record<(typeof FILTER_KEYS)[number], undefined>
