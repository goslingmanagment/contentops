import type {
  Account,
  AccountCode,
  PlanAccountGroup,
  PlanDay,
  PlanRow,
  SlotGap,
} from '@contentops/contracts'

/**
 * Список дня (DESIGN §4.11) как плоская последовательность для виртуального списка:
 * заголовок группы страницы, строки и места нормы по времени, строка «Hub видел пост без
 * плана». Во виде «по времени» — одна лента, одинаковые строки нескольких страниц слиты.
 */
export type DayListItem =
  | { kind: 'group'; key: string; account: Account; group: PlanAccountGroup; rowIds: string[] }
  | { kind: 'row'; key: string; row: PlanRow; accountLabel: string | null }
  | { kind: 'merged'; key: string; rows: PlanRow[] }
  | { kind: 'gap'; key: string; gap: SlotGap; accountLabel: string | null }
  | { kind: 'unplanned'; key: string; account: AccountCode; count: number }
  | { kind: 'cancelled'; key: string; count: number }

/** Высоты фиксированы (§7.3): строка и место нормы 54, заголовок группы 48. */
export const DAY_ITEM_HEIGHT: Record<DayListItem['kind'], number> = {
  group: 48,
  row: 54,
  merged: 54,
  gap: 54,
  unplanned: 36,
  cancelled: 48,
}

export interface DayListOptions {
  accounts: readonly Account[]
  /** Чип «Все страницы ▾»: пусто — все. */
  pages: readonly AccountCode[]
  /** Чип «Мои»: группы и места нормы тех страниц, где выкладывает вошедший. */
  mineOf: string | null
  byTime: boolean
}

type Slot = { kind: 'row'; row: PlanRow } | { kind: 'gap'; gap: SlotGap; index: number }

/** Строки без времени («весь день») идут первыми, места нормы — после строк того же времени. */
function slotSortKey(slot: Slot): string {
  const time = slot.kind === 'row' ? slot.row.time : slot.gap.time
  return `${time ?? '00:00'}|${time === null ? 0 : 1}|${slot.kind === 'row' ? 0 : 1}`
}

function sortSlots(slots: Slot[]): Slot[] {
  return slots.sort((left, right) => slotSortKey(left).localeCompare(slotSortKey(right)))
}

function gapKey(gap: SlotGap, index: number): string {
  return `gap:${gap.account}:${gap.kind}:${index}`
}

function visibleGroups(day: PlanDay, options: DayListOptions): PlanAccountGroup[] {
  return options.accounts.flatMap((account) => {
    const group = day.groups.find((candidate) => candidate.account === account.code)
    if (!group) {
      return []
    }
    if (options.pages.length > 0 && !options.pages.includes(account.code)) {
      return []
    }
    const hasRows = day.rows.some((row) => row.account === account.code && !row.cancelled)
    if (options.mineOf && group.assignee?.id !== options.mineOf && !hasRows) {
      return []
    }
    return [group]
  })
}

function groupItems(day: PlanDay, account: Account, group: PlanAccountGroup): DayListItem[] {
  const rows = day.rows.filter((row) => row.account === account.code && !row.cancelled)
  const gaps = day.gaps.filter((gap) => gap.account === account.code)
  const slots = sortSlots([
    ...rows.map((row): Slot => ({ kind: 'row', row })),
    ...gaps.map((gap, index): Slot => ({ kind: 'gap', gap, index })),
  ])
  const items: DayListItem[] = [
    {
      kind: 'group',
      key: `group:${account.code}`,
      account,
      // Hub одинаково не работает везде — строка одна, у заголовка дня (§3.11).
      group: day.integration ? { ...group, integration: null } : group,
      rowIds: rows.map((row) => row.id),
    },
    ...slots.map(
      (slot): DayListItem =>
        slot.kind === 'row'
          ? { kind: 'row', key: slot.row.id, row: slot.row, accountLabel: null }
          : { kind: 'gap', key: gapKey(slot.gap, slot.index), gap: slot.gap, accountLabel: null },
    ),
  ]
  if (group.unplanned_posts > 0) {
    items.push({
      kind: 'unplanned',
      key: `unplanned:${account.code}`,
      account: account.code,
      count: group.unplanned_posts,
    })
  }
  return items
}

/** Одинаковый объект в одно время на нескольких страницах сливается в одну строку. */
function mergeKey(row: PlanRow): string | null {
  if (!row.manifest || !row.time || row.cancelled) {
    return null
  }
  return `${row.manifest.item_id}|${row.surface}|${row.time}|${row.verdict.level}|${row.mark_button}`
}

function byTimeItems(day: PlanDay, options: DayListOptions, groups: PlanAccountGroup[]) {
  const shown = new Set(groups.map((group) => group.account))
  const labelOf = (code: AccountCode) =>
    options.accounts.find((account) => account.code === code)?.label ?? code
  const rows = day.rows.filter((row) => shown.has(row.account) && !row.cancelled)
  const gaps = day.gaps.filter((gap) => shown.has(gap.account))
  const slots = sortSlots([
    ...rows.map((row): Slot => ({ kind: 'row', row })),
    ...gaps.map((gap, index): Slot => ({ kind: 'gap', gap, index })),
  ])
  const items: DayListItem[] = []
  const merged = new Map<string, Extract<DayListItem, { kind: 'merged' }>>()
  for (const slot of slots) {
    if (slot.kind === 'gap') {
      items.push({
        kind: 'gap',
        key: gapKey(slot.gap, slot.index),
        gap: slot.gap,
        accountLabel: labelOf(slot.gap.account),
      })
      continue
    }
    const key = mergeKey(slot.row)
    const existing = key ? merged.get(key) : undefined
    if (existing) {
      existing.rows.push(slot.row)
      existing.key = `merged:${existing.rows.map((row) => row.id).join('+')}`
      continue
    }
    const item: Extract<DayListItem, { kind: 'merged' }> = {
      kind: 'merged',
      key: slot.row.id,
      rows: [slot.row],
    }
    if (key) {
      merged.set(key, item)
    }
    items.push(item)
  }
  // Одиночная «слитая» строка — обычная строка: у неё своё меню и своя кнопка.
  return items.map(
    (item): DayListItem =>
      item.kind === 'merged' && item.rows.length === 1 && item.rows[0]
        ? {
            kind: 'row',
            key: item.rows[0].id,
            row: item.rows[0],
            accountLabel: labelOf(item.rows[0].account),
          }
        : item,
  )
}

export function buildDayList(day: PlanDay, options: DayListOptions): DayListItem[] {
  const groups = visibleGroups(day, options)
  const items = options.byTime
    ? byTimeItems(day, options, groups)
    : groups.flatMap((group) => {
        const account = options.accounts.find((candidate) => candidate.code === group.account)
        return account ? groupItems(day, account, group) : []
      })
  const cancelled = day.rows.filter(
    (row) => row.cancelled && (options.pages.length === 0 || options.pages.includes(row.account)),
  )
  if (cancelled.length > 0) {
    // Отменённые идут одной кучей в конце — у каждой строки её страница: «OF VIP · …».
    const labelOf = (code: AccountCode) =>
      options.accounts.find((account) => account.code === code)?.label ?? code
    items.push({ kind: 'cancelled', key: CANCELLED_KEY, count: cancelled.length })
    items.push(
      ...cancelled.map(
        (row): DayListItem => ({
          kind: 'row',
          key: row.id,
          row,
          accountLabel: labelOf(row.account),
        }),
      ),
    )
  }
  return items
}

/** Ключ заголовка «Отменённые»: к нему прокручивает «⋯ → Отменённые». */
export const CANCELLED_KEY = 'cancelled'

/**
 * Куда прокрутить после «⋯ → Отменённые»: к последней отменённой строке — раздел в конце
 * списка, так на виду и заголовок, и все отменённые.
 */
export function cancelledRevealKey(items: readonly DayListItem[]): string | null {
  const head = items.findIndex((item) => item.key === CANCELLED_KEY)
  return head >= 0 ? (items.at(-1)?.key ?? null) : null
}

/** Строки, стоящие за элементом списка (слитая строка — несколько). */
export function rowsOfItem(item: DayListItem): PlanRow[] {
  if (item.kind === 'row') {
    return [item.row]
  }
  return item.kind === 'merged' ? item.rows : []
}

export function isRowItem(item: DayListItem): boolean {
  return item.kind === 'row' || item.kind === 'merged'
}
