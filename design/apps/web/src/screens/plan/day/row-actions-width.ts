import type { PlanRow } from '@contentops/contracts'
import { type RowAction, rowActionOf } from '../shared/row-action'
import type { DayListItem } from './day-list'

/**
 * Ширина колонки действий дня (DESIGN §4.11) — по самой широкой кнопке среди строк этого
 * дня, а не на все случаи сразу: место, которое не нужно «Отметить и подтвердить», уходит
 * названию и слову состояния. Одна на весь список — колонки строк стоят ровно, и ширина не
 * прыгает при прокрутке виртуального списка. Кнопки sm замерены на шрифте интерфейса.
 */
const ACTION_PX: Record<RowAction['kind'], number> = {
  mark: 134,
  mark_confirm: 180,
  check: 97,
  cancel: 132,
  montage: 162,
  none: 0,
}
/** «↓» 30 и зазор 4. */
const DOWNLOAD_PX = 34
/** «Выбрать» у пустого места нормы. */
const PICK_PX = 77
/** Вид «по времени»: «Отметить все 3» и «Отметить и подтвердить все 2». */
const MARK_ALL_PX = 141
const CONFIRM_ALL_PX = 216

function rowPx(row: PlanRow, canAct: boolean): number {
  const download = row.manifest && canAct && !row.cancelled ? DOWNLOAD_PX : 0
  return download + ACTION_PX[rowActionOf(row, canAct).kind]
}

function mergedPx(rows: readonly PlanRow[], canAct: boolean): number {
  const open = rows.every(
    (row) => row.verdict.level === 'planned' || row.verdict.level === 'missed',
  )
  if (!canAct || !open) return 0
  return rows[0]?.mark_button === 'mark_confirm' ? CONFIRM_ALL_PX : MARK_ALL_PX
}

function itemPx(item: DayListItem, canAct: boolean): number {
  switch (item.kind) {
    case 'row':
      return rowPx(item.row, canAct)
    case 'merged':
      return mergedPx(item.rows, canAct)
    case 'gap':
      return canAct ? PICK_PX : 0
    default:
      return 0
  }
}

/** Ширина колонки действий списка дня в px: хотя бы под «↓». */
export function rowActionsWidth(items: readonly DayListItem[], canAct: boolean): number {
  return items.reduce((widest, item) => Math.max(widest, itemPx(item, canAct)), DOWNLOAD_PX)
}
