import type {
  Account,
  AccountCode,
  GapKind,
  LocalDate,
  PlanRow,
  PlanWeek,
  SlotGap,
  SurfaceKind,
} from '@contentops/contracts'

/**
 * Неделя как таблица постинга (DESIGN §4.12): ячейка «день × страница» — строки по времени
 * и пустые места нормы. Порядок строк один на всю неделю: по дням, страницам, времени —
 * по нему работает выделение `Shift`.
 */
export type CellItem =
  | { kind: 'row'; key: string; row: PlanRow }
  | { kind: 'gap'; key: string; gap: SlotGap }

function timeKey(time: string | null): string {
  return time ?? '00:00'
}

export function cellItems(week: PlanWeek, date: LocalDate, account: AccountCode): CellItem[] {
  const rows = week.rows
    .filter((row) => row.date === date && row.account === account)
    .map((row): CellItem => ({ kind: 'row', key: row.id, row }))
  const gaps = week.gaps
    .filter((gap) => gap.date === date && gap.account === account)
    .map((gap, index): CellItem => ({ kind: 'gap', key: `gap:${date}:${account}:${index}`, gap }))
  return [...rows, ...gaps].sort((left, right) => {
    const leftTime = left.kind === 'row' ? left.row.time : left.gap.time
    const rightTime = right.kind === 'row' ? right.row.time : right.gap.time
    return timeKey(leftTime).localeCompare(timeKey(rightTime))
  })
}

export function orderedRows(week: PlanWeek, accounts: readonly Account[]): PlanRow[] {
  return week.dates.flatMap((date) =>
    accounts.flatMap((account) =>
      cellItems(week, date, account.code).flatMap((item) =>
        item.kind === 'row' ? [item.row] : [],
      ),
    ),
  )
}

/** «+ фуп», «+ пост на стену» — короткая подпись места нормы в ячейке недели. */
export const GAP_SHORT: Record<GapKind, string> = {
  fyp: '+ фуп',
  wall: '+ пост на стену',
  life_vault: '+ лайф в vault',
  story: '+ сториз',
  release: '+ выпуск PPV',
}

/** Какой тип показывает ящик по «пусто N» столбца: первого пустого места страницы. */
export function firstGapSurface(week: PlanWeek, account: AccountCode): SurfaceKind | null {
  return week.gaps.find((gap) => gap.account === account)?.surface ?? null
}

/** Отмеченную строку перенести нельзя — сначала «Снять отметку» (§4.12). */
export function canMove(row: PlanRow): boolean {
  return row.mark === null && row.cancelled === null
}
