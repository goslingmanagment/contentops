import type { Account, AccountCode, CatalogEntry, ItemId, LocalDate } from '@contentops/contracts'
import type { SortOption } from '@contentops/ui/components/field-header'
import { type PageSummariesView, pageSummaryOf } from '@/data/catalog'

/**
 * Сортировки раздела (DESIGN §4.2): не больше четырёх на тип. «Давно не было на ▾» и
 * «Лучше зашёл на ▾» выбирают страницу: `stale:lora-2`, `best:lora-1`.
 */
export type SortBase = 'number' | 'arrived' | 'shot' | 'duration' | 'stale' | 'best'

export interface SectionSort {
  base: SortBase
  /** Страница у «давно не было» и «лучше зашёл». */
  account: AccountCode | null
}

const PAGE_SORTS: ReadonlySet<SortBase> = new Set(['stale', 'best'])

const SORT_LABEL: Record<SortBase, string> = {
  number: 'По номеру',
  arrived: 'По дате прихода',
  shot: 'По дате съёмки',
  duration: 'По длительности',
  stale: 'Давно не было на',
  best: 'Лучше зашёл на',
}

export function sortValue(sort: SectionSort): string {
  return sort.account ? `${sort.base}:${sort.account}` : sort.base
}

/** Сортировка из адреса; чужая для типа или без страницы — сортировка типа по умолчанию. */
export function parseSort(
  value: string | undefined,
  allowed: readonly SortBase[],
  accounts: readonly Account[],
): SectionSort {
  const fallback: SectionSort = { base: allowed[0] ?? 'number', account: null }
  const [base, account] = (value ?? '').split(':')
  const known = allowed.find((candidate) => candidate === base)
  if (!known) {
    return fallback
  }
  if (!PAGE_SORTS.has(known)) {
    return { base: known, account: null }
  }
  return accounts.some((candidate) => candidate.code === account)
    ? { base: known, account: account ?? null }
    : fallback
}

/** Страницы, где «лучше зашёл» что-то значит: просмотры приходят из Hub для Fansly. */
function pagesFor(base: SortBase, accounts: readonly Account[]): readonly Account[] {
  return base === 'best' ? accounts.filter((account) => account.platform === 'fansly') : accounts
}

export function sortOptions(
  allowed: readonly SortBase[],
  accounts: readonly Account[],
): SortOption[] {
  return allowed.map((base) =>
    PAGE_SORTS.has(base)
      ? {
          value: base,
          label: SORT_LABEL[base],
          options: pagesFor(base, accounts).map((account) => ({
            value: `${base}:${account.code}`,
            label: account.label,
          })),
        }
      : { value: base, label: SORT_LABEL[base] },
  )
}

type Compare = (left: CatalogEntry, right: CatalogEntry) => number

const newestId: Compare = (left, right) => right.id.localeCompare(left.id)

function byDate(pick: (entry: CatalogEntry) => LocalDate | null): Compare {
  return (left, right) =>
    (pick(right) ?? '').localeCompare(pick(left) ?? '') || newestId(left, right)
}

/** Ключ страницы для каждого объекта заранее: сравнение сотен фупов не ищет сводку заново. */
function byPageKey(
  entries: readonly CatalogEntry[],
  key: (id: ItemId) => number | string | null,
  direction: 'asc' | 'desc',
): Compare {
  const keys = new Map(entries.map((entry) => [entry.id, key(entry.id)]))
  return (left, right) => {
    const a = keys.get(left.id) ?? null
    const b = keys.get(right.id) ?? null
    if (a === null || b === null) {
      return a === b ? newestId(left, right) : a === null ? 1 : -1
    }
    const order = a < b ? -1 : a > b ? 1 : 0
    return (direction === 'asc' ? order : -order) || newestId(left, right)
  }
}

interface SortContext {
  summaries: PageSummariesView | undefined
  /** Секстинги идут по номеру вверх, остальные — вниз. */
  numberOrder: 'asc' | 'desc'
}

export function sortEntries(
  entries: readonly CatalogEntry[],
  sort: SectionSort,
  { summaries, numberOrder }: SortContext,
): CatalogEntry[] {
  const account = sort.account ?? ''
  const compare: Record<SortBase, () => Compare> = {
    number: () => (numberOrder === 'asc' ? (left, right) => -newestId(left, right) : newestId),
    arrived: () => byDate((entry) => entry.arrived_on),
    shot: () => byDate((entry) => entry.shot_on),
    duration: () => (left, right) =>
      (right.duration_s ?? -1) - (left.duration_s ?? -1) || newestId(left, right),
    // Сначала то, что выходило давнее всего; не выходившее — в конце: его ищут «Где залито: нет».
    stale: () =>
      byPageKey(entries, (id) => pageSummaryOf(summaries, id, account)?.last_on ?? null, 'asc'),
    best: () =>
      byPageKey(entries, (id) => pageSummaryOf(summaries, id, account)?.views ?? null, 'desc'),
  }
  return [...entries].sort(compare[sort.base]())
}
