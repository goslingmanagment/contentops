import type { BatchResult } from '@contentops/contracts/domain/pagination'
import type { PlanHub, PlanRow } from '@contentops/contracts/domain/plan'
import { publicationCheck } from '@contentops/contracts/publication'
import { isSwitchOn, type Queryable, type Tx } from '@contentops/db'
import { canCancel, HANDED_TO_PLATFORM, type PublicationStatus } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import { isUuid } from '../commands'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { enqueueRowWork } from '../hub/publish'
import { kindRule, replaceable } from '../hub/publish-rules'
import { hubView, isConfirmedLevel } from '../plan/publication-view'
import { type RowRecord, rowById } from '../plan/records'
import { evaluateRow, loadState, type PlanState } from '../plan/state'
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

  /** «Подготовить» of one row inside the command: the checks, the work, the journal. */
  async function prepareOne(
    tx: Tx,
    actor: Actor,
    model: ModelScope,
    id: string,
    requestId: string,
  ): Promise<RowRecord> {
    const row = await rowById(tx, model, id, true)
    if (row.cancelled_at) throw new ApiProblem('row_cancelled', 'Не выполнено: строка отменена')
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
    const state = await loadState(tx, model)
    assertNotOut(state, row)
    await queue(tx, model, row, 'prepare', { principalId: actor.id }, requestId)
    await logRow(tx, state, row, { Публикация: WORD.prepare })
    return row
  }

  /** A row whose placement is already confirmed (by Hub or a person) went out: no second time. */
  function assertNotOut(state: PlanState, row: RowRecord) {
    const current = state.rows.find((candidate) => candidate.id === row.id) ?? row
    if (isConfirmedLevel(evaluateRow(state, current).level)) {
      throw new ApiProblem(
        'publication_refused',
        'Строка уже вышла: размещение подтверждено — публиковать заново нечего',
      )
    }
  }

  /** Agents prepare, people send (SPEC §11.1): the server refuses a token here. */
  function assertPerson(actor: Actor) {
    if (actor.type !== 'person') {
      throw new ApiProblem('forbidden', 'Отправить может только человек: агент только готовит')
    }
  }

  /** «Отправить» of one row: the draft the person saw, its checks still passing. */
  async function sendOne(
    tx: Tx,
    actor: Actor,
    model: ModelScope,
    id: string,
    version: number,
    requestId: string,
  ): Promise<RowRecord> {
    assertPerson(actor)
    const row = await rowById(tx, model, id, true)
    if (row.cancelled_at) throw new ApiProblem('row_cancelled', 'Не выполнено: строка отменена')
    await assertPublishing(tx, model, row)
    if (row.hub_publication_id === null || row.hub_status !== 'draft') {
      throw new ApiProblem('publication_refused', 'Черновика в Hub нет — сначала «Подготовить»')
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
    const state = await loadState(tx, model)
    assertNotOut(state, row)
    if (version !== row.hub_version) {
      throw new ApiProblem(
        'version_mismatch',
        'Черновик изменился — посмотрите проверки Hub снова',
        {
          current: row.hub_version,
        },
      )
    }
    await queue(tx, model, row, 'send', { principalId: actor.id, version }, requestId)
    await logRow(tx, state, row, { Публикация: WORD.send })
    return row
  }

  /** One record of a batch «по каждой записи»: a refusal stays its own result (§3.3). */
  async function batchOne(
    tx: Tx,
    id: string,
    run: () => Promise<unknown>,
  ): Promise<BatchResult['results'][number]> {
    if (!isUuid(id)) return { id, ok: false, code: 'not_found' }
    await tx.execute(sql`SAVEPOINT publish_batch_one`)
    try {
      await run()
      await tx.execute(sql`RELEASE SAVEPOINT publish_batch_one`)
      return { id, ok: true, code: null }
    } catch (error) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT publish_batch_one`)
      if (error instanceof ApiProblem) return { id, ok: false, code: error.code }
      throw error
    }
  }

  return {
    plan: {
      prepare: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await prepareOne(tx, actor, model, params.row, ctx.requestId)
          return answer(tx, model, row.id)
        }),

      send: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await sendOne(tx, actor, model, params.row, body.version, ctx.requestId)
          return answer(tx, model, row.id)
        }),

      /**
       * «Подготовить 12» (DESIGN §4.11): each row on its own — a row Hub does not publish stays
       * with its code, the rest go.
       */
      prepareMany: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const results: BatchResult['results'] = []
          for (const id of [...new Set(body.row_ids)]) {
            results.push(
              await batchOne(tx, id, () => prepareOne(tx, actor, model, id, ctx.requestId)),
            )
          }
          return { results }
        }),

      /**
       * «Отправить 12» one window with the summary of Hub's checks: rows with a blocking check
       * stay, the rest go. A person only, for the whole batch.
       */
      sendMany: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          assertPerson(actor)
          const model = modelOf(ctx.model)
          const results: BatchResult['results'] = []
          const seen = new Set<string>()
          for (const { id, version } of body.rows) {
            if (seen.has(id)) continue
            seen.add(id)
            results.push(
              await batchOne(tx, id, () => sendOne(tx, actor, model, id, version, ctx.requestId)),
            )
          }
          return { results }
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
