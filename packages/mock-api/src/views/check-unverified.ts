import type { CheckList, UnverifiedRow } from '@contentops/contracts/domain/check'
import type { AccountCode } from '@contentops/contracts/domain/common'
import type { SurfaceKind } from '@contentops/contracts/domain/placement'
import { evaluateRow, evaluateTrack, type FactsContext, hubCoverage } from '../fixtures/facts'
import type { PlacementTrack, PlanRowRecord } from '../fixtures/world-types'

/**
 * «Hub не смог проверить N» (DESIGN §4.15): tracks and plan rows whose level is
 * «не проверено». The count stays out of the tab number; the rows open on «Почему».
 * Where Hub is not set up or switched off it does not check at all, so nothing there is
 * «не смог проверить»: the header already says «Hub не настроен» / «Hub выключен».
 */

function hubChecks(context: FactsContext, account: AccountCode, surface: SurfaceKind): boolean {
  const state = hubCoverage(context, account, surface).state
  return state !== 'unset' && state !== 'off'
}

function thumbOf(context: FactsContext, itemId: string | null) {
  const record = itemId ? context.model.items.get(itemId) : undefined
  return record ? { title: record.entry.title, thumb: record.entry.cover } : null
}

function rowOf(
  context: FactsContext,
  reason: string,
  row: PlanRowRecord | undefined,
  track: PlacementTrack | null,
): UnverifiedRow | null {
  const itemId = track?.item_id ?? row?.item_id ?? null
  const account = track?.account ?? row?.account
  const surface = track?.surface ?? row?.surface
  if (!account || !surface || !hubChecks(context, account, surface)) return null
  const item = thumbOf(context, itemId)
  return {
    id: track?.id ?? row?.id ?? '',
    case_id: track && surface === 'vault' ? track.id : null,
    reason,
    item_id: itemId,
    title: item?.title ?? 'пост без плана',
    thumb: item?.thumb ?? null,
    account,
    surface,
    slot: row ? { date: row.date, time: row.time } : null,
  }
}

function newestFirst(left: UnverifiedRow, right: UnverifiedRow): number {
  const key = (row: UnverifiedRow) => `${row.slot?.date ?? ''} ${row.slot?.time ?? ''}`
  return key(right).localeCompare(key(left))
}

export function unverifiedRows(context: FactsContext): UnverifiedRow[] {
  const rows: UnverifiedRow[] = []
  const rowsWithTrack = new Set<string>()
  for (const track of context.model.tracks) {
    if (track.plan_row_id) rowsWithTrack.add(track.plan_row_id)
    const verdict = evaluateTrack(context, track)
    if (verdict.level !== 'cannot_verify') continue
    const row = track.plan_row_id ? context.model.plan_rows.get(track.plan_row_id) : undefined
    const view = rowOf(context, verdict.reason, row, track)
    if (view) rows.push(view)
  }
  for (const row of context.model.plan_rows.values()) {
    if (rowsWithTrack.has(row.id)) continue
    const verdict = evaluateRow(context, row)
    if (verdict.level !== 'cannot_verify') continue
    const view = rowOf(context, verdict.reason, row, null)
    if (view) rows.push(view)
  }
  return rows.sort(newestFirst)
}

/** Groups by reason with their counts, the biggest first. */
export function unverifiedSummary(rows: readonly UnverifiedRow[]): CheckList['unverified'] {
  const groups = new Map<string, number>()
  for (const row of rows) groups.set(row.reason, (groups.get(row.reason) ?? 0) + 1)
  const list = [...groups.entries()].map(([reason, count]) => ({ reason, count }))
  return {
    total: rows.length,
    groups: list.sort((left, right) => right.count - left.count),
  }
}
