import type { MarkKind, PlanRow } from '@contentops/contracts'
import { z } from 'zod'
import { readStored, writeStored } from '@/lib/browser-storage'
import { isAwaitingMontage, isOpenRow } from './plan-text'

/**
 * Одна кнопка строки по случаю (DESIGN §4.11): «Отметить ▾», «Отметить и подтвердить»,
 * «Подготовить» / «Отправить» (публикация через Hub), «Сверить», «Отменить строку»,
 * «Загрузить монтаж» — или ничего.
 */
export type RowAction =
  | { kind: 'mark'; timed: boolean }
  | { kind: 'mark_confirm' }
  | { kind: 'prepare'; again: boolean }
  | { kind: 'send'; blocked: string | null }
  | { kind: 'hub_pending'; op: 'prepare' | 'send' | 'cancel' }
  | { kind: 'check' }
  | { kind: 'cancel' }
  | { kind: 'montage' }
  | { kind: 'none' }

/**
 * На странице с публикацией через Hub вместо «Отметить ▾» — «Подготовить», затем «Отправить»
 * (DESIGN §4.11); после ▲ «не вышло» и отмены публикации — «Подготовить» заново.
 */
function hubActionOf(row: PlanRow): RowAction | null {
  const hub = row.hub
  if (!hub?.enabled || hub.manual) {
    return null
  }
  if (hub.pending) {
    return { kind: 'hub_pending', op: hub.pending }
  }
  const publication = hub.publication
  if (publication?.state === 'draft' && !publication.stale) {
    const blocking = publication.checks.find((check) => check.severity === 'blocking')
    return {
      kind: 'send',
      blocked: publication.blocked ? (blocking?.text ?? 'Hub не пропускает черновик') : null,
    }
  }
  if (hub.can_prepare) {
    return { kind: 'prepare', again: publication !== null }
  }
  return null
}

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
  const publish = hubActionOf(row)
  if (publish) {
    return publish
  }
  if (!isOpenRow(row)) {
    return { kind: 'none' }
  }
  if (row.mark_button === 'mark_confirm') {
    return { kind: 'mark_confirm' }
  }
  return { kind: 'mark', timed: row.surface === 'story' || row.surface === 'dm' }
}

/**
 * Строки выделения, которые публикуются через Hub (DESIGN §4.11): «Подготовить N» — строки без
 * черновика или после «не вышло»; «Отправить N» — черновики Hub, из них с блокирующей проверкой
 * остаются (`blocked`). Работа уже идёт — строка ни туда, ни сюда.
 */
export function publishableRows(rows: readonly PlanRow[]) {
  const prepare: PlanRow[] = []
  const send: PlanRow[] = []
  const blocked: PlanRow[] = []
  for (const row of rows) {
    if (row.cancelled || isAwaitingMontage(row)) {
      continue
    }
    const action = hubActionOf(row)
    if (action?.kind === 'prepare') {
      prepare.push(row)
    } else if (action?.kind === 'send') {
      ;(action.blocked ? blocked : send).push(row)
    }
  }
  return { prepare, send, blocked, all: new Set([...prepare, ...send, ...blocked]) }
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
