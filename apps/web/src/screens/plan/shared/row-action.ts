import type { MarkKind, PlanRow } from '@contentops/contracts'
import { z } from 'zod'
import { readStored, writeStored } from '@/lib/browser-storage'
import { isAwaitingMontage, isOpenRow } from './plan-text'

/**
 * Одна кнопка строки по случаю (DESIGN §4.11): «Отметить ▾», «Отметить и подтвердить»,
 * «Сверить», «Отменить строку», «Загрузить монтаж» — или ничего.
 */
export type RowAction =
  | { kind: 'mark'; timed: boolean }
  | { kind: 'mark_confirm' }
  | { kind: 'check' }
  | { kind: 'cancel' }
  | { kind: 'montage' }
  | { kind: 'none' }

export function rowActionOf(row: PlanRow, canAct: boolean): RowAction {
  if (!canAct || row.cancelled) {
    return { kind: 'none' }
  }
  if (isAwaitingMontage(row)) {
    return { kind: 'montage' }
  }
  if (row.verdict.level === 'blocked_second_person') {
    return { kind: 'cancel' }
  }
  if (row.verdict.sign === 'turn') {
    return { kind: 'check' }
  }
  if (!isOpenRow(row)) {
    return { kind: 'none' }
  }
  if (row.mark_button === 'mark_confirm') {
    return { kind: 'mark_confirm' }
  }
  return { kind: 'mark', timed: row.surface === 'story' || row.surface === 'dm' }
}

/** Строки, которые можно отметить пакетом одним видом (массовая отметка не смешивает два). */
export function markableRows(rows: readonly PlanRow[]) {
  const open = rows.filter((row) => isOpenRow(row) && !isAwaitingMontage(row))
  return {
    mark: open.filter((row) => row.mark_button === 'mark'),
    confirm: open.filter((row) => row.mark_button === 'mark_confirm'),
  }
}

const MARK_KIND_KEY = 'contentops:plan:mark-kind'
const MarkKindSchema = z.enum(['posted', 'scheduled'])

/** «Отметить ▾»: по умолчанию — вариант, выбранный в прошлый раз (§4.11). */
export function rememberedMarkKind(): MarkKind {
  return MarkKindSchema.safeParse(readStored('local', MARK_KIND_KEY)).data ?? 'posted'
}

export function rememberMarkKind(kind: MarkKind): void {
  writeStored('local', MARK_KIND_KEY, kind)
}

export const MARK_KIND_LABEL: Record<MarkKind, string> = {
  posted: 'выложено',
  scheduled: 'в планировщике',
}
