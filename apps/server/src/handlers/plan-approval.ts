import { weekDates } from '@contentops/contracts/clock'
import { IsoWeekSchema } from '@contentops/contracts/domain/common'
import type { BatchResult } from '@contentops/contracts/domain/pagination'
import { formatDayRange } from '@contentops/contracts/format'
import { logAction, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { approvable } from '../plan/approval'
import { loadRows, type RowRecord } from '../plan/records'
import { loadState } from '../plan/state'
import { accountId } from '../plan/writes'
import type { Services } from '../services'

/**
 * «Утвердить неделю» and «Отозвать» (decision of the owner 11.11.2026; SPEC §7, §11.1; DESIGN
 * §4.12): the owner, a person, stamps the rows of one page's ISO week (Monday–Sunday by the
 * row's date, Moscow) with the versions he saw. The stamp changes no version; an edit of the row
 * leaves it unapproved, a send spends it. An agent then sends the free rows by the stamp.
 */

/** The owner, and a person: an agent never approves, whatever its role. */
function assertOwnerPerson(actor: Actor) {
  if (actor.type !== 'person' || actor.role !== 'owner') {
    throw new ApiProblem('forbidden', 'Утверждает неделю только владелец')
  }
}

function weekOf(raw: string) {
  const parsed = IsoWeekSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiProblem('invalid_request', 'Неделя пишется как 2026-W46', { week: raw })
  }
  return parsed.data
}

/** «Fansly 1 · 9–15 нояб.» — the subject of the journal line. */
function weekLabel(label: string, week: string): string {
  const dates = weekDates(week)
  const [first, last] = [dates[0], dates[6]]
  return first && last ? `${label} · ${formatDayRange(first, last)}` : label
}

export function planApprovalHandlers(services: Services): HandlerRegistry {
  const { command } = services

  /** The rows of the page's week, locked; and the page's label for the journal. */
  async function weekRows(tx: Tx, model: ModelScope, account: string, week: string) {
    const pageId = await accountId(tx, model, account)
    const dates = weekDates(week)
    const rows = await loadRows(
      tx,
      model,
      sql`AND r.account_id = ${pageId}::uuid
          AND r.slot_date BETWEEN ${dates[0]}::date AND ${dates[6]}::date`,
      true,
    )
    const state = await loadState(tx, model)
    const label = state.view.accounts.find((page) => page.code === account)?.label ?? account
    return { rows, state, label }
  }

  async function stamp(tx: Tx, model: ModelScope, row: RowRecord, actor: Actor) {
    await tx.execute(sql`
      UPDATE posting_plan_rows
         SET approved_at = now(), approved_by = ${actor.id}::uuid, approved_version = row_version
       WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid
         AND row_version = ${row.row_version}`)
  }

  return {
    plan: {
      approveWeek: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          assertOwnerPerson(actor)
          const model = modelOf(ctx.model)
          const week = weekOf(params.week)
          const { rows, state, label } = await weekRows(tx, model, body.account, week)
          const results: BatchResult['results'] = []
          const stamped: { id: string; version: number }[] = []
          const seen = new Set<string>()
          for (const { id, version } of body.rows) {
            if (seen.has(id)) continue
            seen.add(id)
            // Locked above; the state is read after the lock, in the same transaction.
            const row = rows.some((candidate) => candidate.id === id)
              ? state.rows.find((candidate) => candidate.id === id)
              : undefined
            const code = !row
              ? 'not_found'
              : row.cancelled_at
                ? 'row_cancelled'
                : row.marked_at
                  ? 'row_marked'
                  : !approvable(state, row)
                    ? 'publication_refused'
                    : row.row_version !== version
                      ? 'version_mismatch'
                      : null
            if (row && code === null) {
              await stamp(tx, model, row, actor)
              stamped.push({ id, version })
            }
            results.push({ id, ok: code === null, code })
          }
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'plan',
            subjectLabel: weekLabel(label, week),
            after: { Неделя: week, Строк: stamped.length, Строки: stamped },
          })
          return { results }
        }),

      revokeWeekApproval: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          assertOwnerPerson(actor)
          const model = modelOf(ctx.model)
          const week = weekOf(params.week)
          const { rows, label } = await weekRows(tx, model, body.account, week)
          const cleared = rows.filter((row) => row.approved_version !== null)
          for (const row of cleared) {
            await tx.execute(sql`
              UPDATE posting_plan_rows
                 SET approved_at = NULL, approved_by = NULL, approved_version = NULL
               WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
          }
          const list = cleared.map((row) => ({
            id: row.id,
            version: row.approved_version as number,
          }))
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'plan',
            subjectLabel: weekLabel(label, week),
            after: { Неделя: week, Строк: list.length, Строки: list },
          })
          return { results: list.map(({ id }) => ({ id, ok: true, code: null })) }
        }),
    },
  }
}
