import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { BatchResult } from '@contentops/contracts/domain/pagination'
import type { SurfaceKind } from '@contentops/contracts/domain/placement'
import type { Queryable, Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { catalogEntries, contentTag } from '../catalog/entries'
import { modelOf } from '../catalog/ids'
import { type ModelScope, withContentTag } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { loadState } from '../plan/state'
import { notUploadedPage, pageSummaries } from '../plan/summaries'
import { rowView, viewContext } from '../plan/views'
import { insertRow, isRefusal, logRow, refuse, resolveRow, ruleRefusal } from '../plan/writes'
import type { Services } from '../services'
import { integrationViews } from './integrations'
import { issuePlanRow } from './media'

/**
 * The plan seen from the catalog (DESIGN §4.3, §4.4, §10.2): the page summary index computed
 * from placements and plan rows, «Ещё не залито» of a page with the same function, «Уже
 * залито» and «Залить сейчас» — plan rows created marked or for today.
 */

function plain({
  uid: _uid,
  created_at: _at,
  ...entry
}: CatalogEntry & { uid: string; created_at: string }): CatalogEntry {
  return entry
}

async function liveEntries(q: Queryable, model: ModelScope): Promise<CatalogEntry[]> {
  return (await catalogEntries(q, model)).map(plain)
}

/** Where «Уже залито» puts an object: a set on the wall, a FYP in FYP, the rest in the vault. */
function surfaceForUpload(entry: CatalogEntry): SurfaceKind {
  if (entry.type === 'set') return 'wall'
  if (entry.type === 'fyp') return 'fyp'
  return 'vault'
}

function todayInMoscow(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
}

export function planObjectHandlers(services: Services): HandlerRegistry {
  const { db, command } = services
  return {
    objects: {
      pageSummaries: async ({ ctx }) => {
        const model = modelOf(ctx.model)
        const state = await loadState(db, model)
        const entries = pageSummaries(state)
        const etag = contentTag('p', entries)
        return withContentTag(ctx, etag, {
          model: model.code,
          etag,
          generated_at: new Date().toISOString(),
          entries,
        })
      },

      notUploaded: async ({ query, ctx }) => {
        const model = modelOf(ctx.model)
        const state = await loadState(db, model)
        if (!state.view.accounts.some((account) => account.code === query.account)) {
          throw new ApiProblem('not_found', 'Такой страницы нет', { account: query.account })
        }
        return notUploadedPage(state, await liveEntries(db, model), query.account)
      },

      alreadyUploaded: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const state = await loadState(tx, model)
          const entries = new Map((await liveEntries(tx, model)).map((entry) => [entry.id, entry]))
          const results: BatchResult['results'] = []
          for (const id of [...new Set(body.items)]) {
            const entry = entries.get(id)
            if (!entry) {
              results.push({ id, ok: false, code: 'not_found' })
              continue
            }
            const one = await resolveRow(tx, model, {
              item_id: id,
              account: body.account,
              surface: surfaceForUpload(entry),
              date: todayInMoscow(),
              time: null,
              fyp_version: null,
              assignee: null,
              note: null,
              requires_new_upload: false,
              awaiting_montage: null,
              marked: 'posted',
            })
            const refusal = isRefusal(one) ? one : ruleRefusal(state, one)
            if (refusal || isRefusal(one)) {
              results.push({ id, ok: false, code: refusal?.code ?? 'invalid_request' })
              continue
            }
            await tx.execute(sql`SAVEPOINT already_uploaded`)
            try {
              const rowId = await insertRow(tx, state, actor, one, { unknownTime: true })
              const after = await loadState(tx, model)
              const row = after.rows.find((candidate) => candidate.id === rowId)
              if (row) await logRow(tx, after, row, { 'Уже залито': 'да' })
              await tx.execute(sql`RELEASE SAVEPOINT already_uploaded`)
              results.push({ id, ok: true, code: null })
            } catch (error) {
              await tx.execute(sql`ROLLBACK TO SAVEPOINT already_uploaded`)
              if (!(error instanceof ApiProblem)) throw error
              results.push({ id, ok: false, code: error.code })
            }
          }
          return { results }
        }),

      uploadNow: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const state = await loadState(tx, model)
          const one = await resolveRow(tx, model, {
            item_id: params.id,
            account: body.account,
            surface: body.surface,
            date: todayInMoscow(),
            // «На сегодня» without an hour: the row is not missed the same minute.
            time: null,
            fyp_version: null,
            assignee: actor.id,
            note: null,
            requires_new_upload: false,
            awaiting_montage: null,
            marked: null,
          })
          if (isRefusal(one)) refuse(one)
          const refusal = ruleRefusal(state, one)
          if (refusal) refuse(refusal)
          const rowId = await insertRow(tx, state, actor, one)
          const after = await loadState(tx, model)
          const row = after.rows.find((candidate) => candidate.id === rowId)
          if (!row) throw new Error('upload-now row vanished')
          await logRow(tx, after, row, { 'Залить сейчас': 'да' })
          const download = await issuePlanRow(tx as Tx, actor, model, row, 'platform', true)
          const context = await viewContext(
            tx,
            await loadState(tx, model),
            await integrationViews(tx, services, [model.code]),
            [row],
          )
          return { row: await rowView(context, row), download }
        }),
    },
  }
}
