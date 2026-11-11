import type { RowApproval, WeekColumn } from '@contentops/contracts/domain/plan'
import { replaceable } from '../hub/publish-rules'
import { isConfirmedLevel } from './publication-view'
import { actorRef, type RowRecord } from './records'
import { evaluateRow, type PlanState } from './state'

/**
 * «Утвердить неделю» (decision of the owner 11.11.2026; SPEC §7, §11.1; DESIGN §4.12): the owner
 * stamps the rows of a page's ISO week as he saw them, an agent then sends the free ones. A row
 * is approved while the stamp names its current version; a send spends the stamp (`publish.ts`).
 */

/**
 * The rows an approval is about: they may still be sent — live, with their files, not marked,
 * their publication not in Hub's hands, not confirmed out.
 */
export function approvable(state: PlanState, row: RowRecord): boolean {
  return (
    !row.cancelled_at &&
    !row.marked_at &&
    row.manifest_id !== null &&
    replaceable(row.hub_status) &&
    !isConfirmedLevel(evaluateRow(state, row).level)
  )
}

/** The stamp of a row as the row shows it; `null` — none. */
export function rowApproval(state: PlanState, row: RowRecord): RowApproval | null {
  if (row.approved_at === null || row.approved_version === null) return null
  return {
    at: row.approved_at,
    by: actorRef(state.people, row.approved_by),
    version: row.approved_version,
    current: row.approved_version === row.row_version,
  }
}

/** «Утвердить неделю · N», «утверждено 11.11 · N», «изменено после · K» of a page's column. */
export function weekApproval(
  state: PlanState,
  rows: readonly RowRecord[],
): NonNullable<WeekColumn['approval']> {
  const open = rows.filter((row) => approvable(state, row))
  const stamped = open.filter((row) => row.approved_version !== null)
  const latest = [...stamped].sort((a, b) =>
    (b.approved_at ?? '').localeCompare(a.approved_at ?? ''),
  )[0]
  return {
    approved: stamped.filter((row) => row.approved_version === row.row_version).length,
    changed: stamped.filter((row) => row.approved_version !== row.row_version).length,
    unapproved: open.length - stamped.length,
    at: latest?.approved_at ?? null,
    by: latest ? actorRef(state.people, latest.approved_by) : null,
  }
}
