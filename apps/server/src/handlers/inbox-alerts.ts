import type { InboxAlert, InboxAlertList } from '@contentops/contracts/domain/inbox'
import { DEFAULT_PAGE_LIMIT } from '@contentops/contracts/domain/pagination'
import { logAction, type Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import { filterDigest, pageOf, readCursor } from '../catalog/paging'
import { instant, isUuid, requirePerson } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { actorRef, loadPeople, type People } from '../plan/records'
import type { Services } from '../services'

/**
 * «Копии кастомов» (SPEC §6.2, DESIGN §4.8): the signals `intake/custom-copies.ts` raises, read
 * by everyone with the model — an agent's daily routine too — and closed by «Понятно» of the
 * owner, a person: an agent never silences one.
 */

interface AlertRow extends Record<string, unknown> {
  id: string
  state: 'open' | 'dismissed'
  created_at: string
  resolved_at: string | null
  resolved_by: string | null
  details: { path?: string; relative?: string; source?: 'yandex_disk' | 'dropbox' } | null
  custom: string
  title: string | null
  also_in: string[]
}

const ALERT_COLUMNS = sql`
  rc.id, rc.state, rc.created_at::text AS created_at, rc.resolved_at::text AS resolved_at,
  rc.resolved_by, rc.details, public_item_id(c.type, c.number) AS custom, c.title,
  array(
    SELECT DISTINCT public_item_id(i.type, i.number)
      FROM asset_versions v
      JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                             AND m.kind = 'owned' AND m.removed_at IS NULL
      JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id AND i.deleted_at IS NULL
     WHERE v.model_id = rc.model_id AND i.id <> rc.item_id
       AND (v.source_sha256 = rc.blob_sha256 OR v.master_sha256 = rc.blob_sha256)
     ORDER BY 1) AS also_in`

function alertView(row: AlertRow, people: People): InboxAlert {
  return {
    id: row.id,
    kind: 'custom_copy',
    state: row.state,
    custom: { id: row.custom as InboxAlert['custom']['id'], title: row.title },
    path: row.details?.relative ?? row.details?.path ?? '',
    source: row.details?.source ?? 'dropbox',
    also_in: row.also_in as InboxAlert['also_in'],
    seen_at: instant(row.created_at),
    dismissed:
      row.state === 'dismissed' && row.resolved_at
        ? { at: instant(row.resolved_at), by: actorRef(people, row.resolved_by) }
        : null,
  }
}

async function openCount(q: Queryable, modelId: string): Promise<number> {
  const { rows } = await q.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM review_cases
     WHERE model_id = ${modelId}::uuid AND kind = 'custom_copy' AND state = 'open'`)
  return rows[0]?.n ?? 0
}

export async function alertList(
  q: Queryable,
  model: ModelScope,
  query: {
    state?: 'open' | 'all' | undefined
    since?: string | undefined
    cursor?: string | undefined
    limit?: number | undefined
  },
): Promise<InboxAlertList> {
  const state = query.state ?? 'open'
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT
  const digest = filterDigest(model.code, { state, since: query.since ?? null })
  const after = readCursor(query.cursor, digest)
  const { rows } = await q.execute<AlertRow>(sql`
    SELECT ${ALERT_COLUMNS}
      FROM review_cases rc
      JOIN content_items c ON c.model_id = rc.model_id AND c.id = rc.item_id
     WHERE rc.model_id = ${model.id}::uuid AND rc.kind = 'custom_copy'
       ${state === 'open' ? sql`AND rc.state = 'open'` : sql``}
       ${query.since ? sql`AND rc.created_at >= ${query.since}::timestamptz` : sql``}
       ${after ? sql`AND (rc.created_at, rc.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
     ORDER BY rc.created_at DESC, rc.id DESC
     LIMIT ${limit + 1}`)
  const people = await loadPeople(q)
  const page = pageOf(
    rows,
    limit,
    (row) => alertView(row, people),
    (row) => [row.created_at, row.id],
    digest,
  )
  return { ...page, open: await openCount(q, model.id) }
}

/** Open «Копии кастомов» of the model: the attention marker of the column (DESIGN §2.2). */
export async function openCustomCopies(q: Queryable, modelId: string): Promise<number> {
  return openCount(q, modelId)
}

async function alertById(q: Queryable, model: ModelScope, id: string): Promise<InboxAlert> {
  if (!isUuid(id)) throw new ApiProblem('not_found', 'Такого сигнала нет')
  const { rows } = await q.execute<AlertRow>(sql`
    SELECT ${ALERT_COLUMNS}
      FROM review_cases rc
      JOIN content_items c ON c.model_id = rc.model_id AND c.id = rc.item_id
     WHERE rc.model_id = ${model.id}::uuid AND rc.kind = 'custom_copy' AND rc.id = ${id}::uuid`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такого сигнала нет')
  return alertView(row, await loadPeople(q))
}

export function inboxAlertHandlers(services: Services): HandlerRegistry {
  const { db, command } = services
  return {
    inbox: {
      alerts: ({ query, ctx }) => alertList(db, modelOf(ctx.model), query),

      dismissAlert: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          requirePerson(actor, '«Понятно» отмечает только человек: агент сигнал не гасит')
          if (actor.role !== 'owner') {
            throw new ApiProblem('forbidden', '«Понятно» отмечает владелец')
          }
          const model = modelOf(ctx.model)
          const alert = await alertById(tx, model, params.alert)
          if (alert.state !== 'open') return alert
          await tx.execute(sql`
            UPDATE review_cases
               SET state = 'dismissed', resolved_at = now(), resolved_by = ${actor.id}::uuid,
                   row_version = row_version + 1
             WHERE model_id = ${model.id}::uuid AND id = ${alert.id}::uuid`)
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'review_cases',
            subjectId: alert.id,
            subjectLabel: alert.custom.id,
            before: { Сигнал: 'открыт' },
            after: { Сигнал: 'понятно', Где: alert.path },
          })
          return alertById(tx, model, alert.id)
        }),
    },
  }
}
