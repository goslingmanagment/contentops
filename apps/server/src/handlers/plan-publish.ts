import type { PlanHub, PlanRow } from '@contentops/contracts/domain/plan'
import { publicationCheck } from '@contentops/contracts/publication'
import { isSwitchOn, type Queryable, type Tx } from '@contentops/db'
import { canCancel, HANDED_TO_PLATFORM, type PublicationStatus } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { enqueueRowWork } from '../hub/publish'
import { kindRule, replaceable } from '../hub/publish-rules'
import { hubView } from '../plan/publication-view'
import { type RowRecord, rowById } from '../plan/records'
import { loadState } from '../plan/state'
import { rowView, viewContext } from '../plan/views'
import { logRow } from '../plan/writes'
import type { Services } from '../services'
import { integrationViews } from './integrations'

/**
 * Publication of a plan row through Hub (SPEC §7, §8, §11.1; DESIGN §4.11; PLAN 5б): «Подготовить»
 * (a person or an agent), «Отправить» (a person only — agents prepare, people send), the cancel
 * of ContentOps' own publication before Hub hands it to the platform, and the row's publication
 * as it stands. The work goes to `hub_publish`; the row answers at once with `hub.pending`.
 */

const handed = (status: string | null) =>
  status !== null && (HANDED_TO_PLATFORM as readonly string[]).includes(status)

export const HANDED_TEXT =
  'Hub уже передал публикацию в расписание площадки — снять её может только владелец в Hub'

/** A sent publication holds its row: the slot, the composition and the fields stay as sent. */
export function assertNotSent(row: RowRecord): void {
  if (row.hub_publication_id === null || replaceable(row.hub_status)) return
  if (handed(row.hub_status)) throw new ApiProblem('publication_handed', HANDED_TEXT)
  throw new ApiProblem(
    'publication_refused',
    'Строка отправлена в Hub — сначала отмените публикацию',
  )
}

/**
 * «Отменить строку» of a row whose publication went to Hub also takes the publication off while
 * Hub has not handed it to the platform (DESIGN §4.11); later only the owner, in Hub.
 */
export async function cancelWithRow(
  tx: Tx,
  model: ModelScope,
  row: RowRecord,
  actor: Actor,
  requestId: string,
): Promise<void> {
  if (row.hub_publication_id === null || !row.hub_status) return
  if (handed(row.hub_status)) throw new ApiProblem('publication_handed', HANDED_TEXT)
  if (!canCancel(row.hub_status)) return
  await enqueueRowWork(tx, {
    modelId: model.id,
    accountId: row.account_id,
    op: 'cancel',
    job: { rowId: row.id, principalId: actor.id },
    requestId,
  })
}

export function planPublishHandlers(services: Services): HandlerRegistry {
  const { db, command } = services

  async function answer(q: Queryable, model: ModelScope, id: string): Promise<PlanRow> {
    const state = await loadState(q, model)
    const row = state.rows.find((candidate) => candidate.id === id)
    if (!row) throw new ApiProblem('not_found', 'Такой строки плана нет')
    const context = await viewContext(q, state, await integrationViews(q, services, [model.code]), [
      row,
    ])
    return rowView(context, row)
  }

  /** Hub is set up for the page and its «Публикация» is on (SPEC §8). */
  async function assertPublishing(q: Queryable, model: ModelScope, row: RowRecord) {
    const { rows } = await q.execute<{ hub_page_ref: string | null }>(sql`
      SELECT hub_page_ref FROM accounts
       WHERE model_id = ${model.id}::uuid AND id = ${row.account_id}::uuid`)
    if (!services.secrets.hub || !rows[0]?.hub_page_ref) {
      throw new ApiProblem('publication_refused', 'Hub для этой страницы не настроен')
    }
    const on = await isSwitchOn(q, 'hub.publish', { modelId: model.id, accountId: row.account_id })
    if (!on) {
      throw new ApiProblem(
        'publication_refused',
        'Публикация через Hub выключена для страницы — строку выкладывают руками',
      )
    }
  }

  async function queue(
    tx: Tx,
    model: ModelScope,
    row: RowRecord,
    op: 'prepare' | 'send' | 'cancel',
    job: { principalId: string; version?: number },
    requestId: string,
  ) {
    const { work, created } = await enqueueRowWork(tx, {
      modelId: model.id,
      accountId: row.account_id,
      op,
      job: { rowId: row.id, ...job },
      requestId,
    })
    if (!created && work.dataset !== op) {
      throw new ApiProblem('publication_refused', 'По строке уже идёт работа Hub — подождите')
    }
  }

  const WORD = { prepare: 'подготовить', send: 'отправить', cancel: 'отменить' } as const

  return {
    plan: {
      prepare: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await rowById(tx, model, params.row, true)
          if (row.cancelled_at)
            throw new ApiProblem('row_cancelled', 'Не выполнено: строка отменена')
          if (row.marked_at) {
            throw new ApiProblem('row_marked', 'Строка отмечена: её уже выложили руками')
          }
          if (!row.manifest_id) {
            throw new ApiProblem('invalid_request', 'Строка ждёт файл — публиковать нечего')
          }
          const price = row.price_mills === null ? null : Number(row.price_mills)
          const rule = kindRule(row.platform, row.surface, price)
          if (rule.manual) throw new ApiProblem('publication_refused', rule.manual)
          if (!row.slot_time) {
            throw new ApiProblem(
              'publication_refused',
              'У строки нет времени: Hub публикует ко времени — задайте его',
            )
          }
          await assertPublishing(tx, model, row)
          assertNotSent(row)
          await queue(tx, model, row, 'prepare', { principalId: actor.id }, ctx.requestId)
          await logRow(tx, await loadState(tx, model), row, { Публикация: WORD.prepare })
          return answer(tx, model, row.id)
        }),

      send: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          // Agents prepare, people send (SPEC §11.1): the server refuses a token here.
          if (actor.type !== 'person') {
            throw new ApiProblem(
              'forbidden',
              'Отправить может только человек: агент только готовит',
            )
          }
          const model = modelOf(ctx.model)
          const row = await rowById(tx, model, params.row, true)
          if (row.cancelled_at)
            throw new ApiProblem('row_cancelled', 'Не выполнено: строка отменена')
          await assertPublishing(tx, model, row)
          if (row.hub_publication_id === null || row.hub_status !== 'draft') {
            throw new ApiProblem(
              'publication_refused',
              'Черновика в Hub нет — сначала «Подготовить»',
            )
          }
          if (row.hub_prepared_version !== null && row.row_version > row.hub_prepared_version) {
            throw new ApiProblem(
              'publication_refused',
              'Строку изменили после «Подготовить» — подготовьте заново',
            )
          }
          const blocking = (row.hub_checks?.findings ?? []).find(
            (finding) => finding.severity === 'blocking',
          )
          if (row.hub_checks?.blocked || blocking) {
            throw new ApiProblem(
              'publication_blocked',
              blocking ? publicationCheck(blocking).text : 'Hub не пропускает черновик',
            )
          }
          if (body.version !== row.hub_version) {
            throw new ApiProblem(
              'version_mismatch',
              'Черновик изменился — посмотрите проверки Hub снова',
              { current: row.hub_version },
            )
          }
          await queue(
            tx,
            model,
            row,
            'send',
            { principalId: actor.id, version: body.version },
            ctx.requestId,
          )
          await logRow(tx, await loadState(tx, model), row, { Публикация: WORD.send })
          return answer(tx, model, row.id)
        }),

      cancelPublication: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await rowById(tx, model, params.row, true)
          if (row.hub_publication_id === null || !row.hub_status) {
            throw new ApiProblem('publication_refused', 'У строки нет публикации в Hub')
          }
          if (row.hub_status === 'cancelled') return answer(tx, model, row.id)
          if (handed(row.hub_status)) throw new ApiProblem('publication_handed', HANDED_TEXT)
          if (!canCancel(row.hub_status as PublicationStatus)) {
            throw new ApiProblem('publication_refused', 'Эту публикацию Hub уже не отменяет')
          }
          await queue(tx, model, row, 'cancel', { principalId: actor.id }, ctx.requestId)
          await logRow(tx, await loadState(tx, model), row, { Публикация: WORD.cancel })
          return answer(tx, model, row.id)
        }),

      publication: async ({ params, ctx }): Promise<PlanHub> => {
        const model = modelOf(ctx.model)
        const row = await rowById(db, model, params.row)
        const view = (await answer(db, model, row.id)).hub
        const price = row.price_mills === null ? null : Number(row.price_mills)
        return (
          view ?? {
            enabled: false,
            manual: kindRule(row.platform, row.surface, price).manual,
            publication: null,
            pending: null,
            error: null,
            statuses_at: null,
            can_prepare: false,
            can_send: false,
            can_cancel: false,
          }
        )
      },
    },
  }
}

export { hubView }
