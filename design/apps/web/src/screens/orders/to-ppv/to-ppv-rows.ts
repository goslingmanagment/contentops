import { type CatalogEntry, daysBetween, type FanName, type LocalDate } from '@contentops/contracts'
import type { DeliveredWithin } from '../search'

/** Фильтры «Переделки в PPV» из адреса: `?todo=1&name=no&delivered=week`. */
export interface ToPpvFilters {
  todo: boolean
  name: FanName | undefined
  delivered: DeliveredWithin | undefined
}

/** Строка списка: заголовок группы или кастом (DESIGN §4.2). */
export type ToPpvRow =
  | { kind: 'group'; key: string; label: string; count: number }
  | { kind: 'custom'; key: string; entry: CatalogEntry }

/** Высоты постоянны (§7.3): строка списка 52, заголовок группы 44. */
export const CUSTOM_ROW_HEIGHT = 52
export const GROUP_ROW_HEIGHT = 44

/** «Имени нет» — первыми: их можно брать как есть; затем «не знаю» и «имя есть». */
const NAME_RANK: Record<FanName, number> = { no: 0, unknown: 1, yes: 2 }

const WEEK_DAYS = 7
const MONTH_DAYS = 30

export function fanNameOf(entry: CatalogEntry): FanName {
  return entry.fan_name ?? 'unknown'
}

/** Дата сдачи; у старых кастомов без неё — дата прихода. */
export function deliveredOn(entry: CatalogEntry): LocalDate {
  return entry.delivered_on ?? entry.arrived_on
}

function withinPeriod(entry: CatalogEntry, period: DeliveredWithin, today: LocalDate): boolean {
  const age = daysBetween(deliveredOn(entry), today)
  if (period === 'week') return age <= WEEK_DAYS
  if (period === 'month') return age <= MONTH_DAYS
  return age > MONTH_DAYS
}

function byNameThenDelivery(left: CatalogEntry, right: CatalogEntry): number {
  const rank = NAME_RANK[fanNameOf(left)] - NAME_RANK[fanNameOf(right)]
  return rank !== 0 ? rank : deliveredOn(right).localeCompare(deliveredOn(left))
}

function byDelivery(left: CatalogEntry, right: CatalogEntry): number {
  return deliveredOn(right).localeCompare(deliveredOn(left))
}

export interface ToPpvList {
  /** Все кастомы модели и сколько из них уже в PPV: «Сделано 38 из 197». */
  total: number
  done: number
  /** Сколько прошло фильтры. */
  shown: number
  rows: ToPpvRow[]
}

function group(key: string, label: string, entries: readonly CatalogEntry[]): ToPpvRow[] {
  if (entries.length === 0) return []
  return [
    { kind: 'group', key, label, count: entries.length },
    ...entries.map((entry): ToPpvRow => ({ kind: 'custom', key: entry.id, entry })),
  ]
}

/**
 * Две группы: «Ещё не в PPV» («имени нет» первыми, дальше по дате сдачи) и «Уже в PPV».
 * Считается в браузере по индексу каталога, без запроса (§3.13).
 */
export function toPpvList(
  items: readonly CatalogEntry[],
  filters: ToPpvFilters,
  today: LocalDate,
): ToPpvList {
  const customs = items.filter((entry) => entry.type === 'custom')
  const matching = customs.filter(
    (entry) =>
      (filters.name === undefined || fanNameOf(entry) === filters.name) &&
      (filters.delivered === undefined || withinPeriod(entry, filters.delivered, today)),
  )
  const todo = matching.filter((entry) => entry.ppv_made_as === null).sort(byNameThenDelivery)
  const made = filters.todo
    ? []
    : matching.filter((entry) => entry.ppv_made_as !== null).sort(byDelivery)
  return {
    total: customs.length,
    done: customs.filter((entry) => entry.ppv_made_as !== null).length,
    shown: todo.length + made.length,
    rows: [...group('todo', 'Ещё не в PPV', todo), ...group('made', 'Уже в PPV', made)],
  }
}

export function toPpvRowHeight(row: ToPpvRow): number {
  return row.kind === 'group' ? GROUP_ROW_HEIGHT : CUSTOM_ROW_HEIGHT
}
