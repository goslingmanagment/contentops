import { isoWeekOf } from '@contentops/contracts/clock'
import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import type { BatchResult } from '@contentops/contracts/domain/pagination'
import type { PlanRow, Release } from '@contentops/contracts/domain/plan'
import { markButtonKind } from '@contentops/contracts/placement'
import { enqueueWork, logAction, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { modelOf, publicIdOf } from '../catalog/ids'
import { checkVersion, isUuid, requireActor } from '../commands'
import type { Actor, ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { planDownload } from '../media/downloads'
import { currentDigests } from '../media/pipeline'
import { exportKeyOf, type StoredBatch, storedBatch } from '../media/work/export'
import { checkLine } from '../plan/checks'
import {
  compositionOf,
  currentFiles,
  manifestFiles,
  rowFileKeys,
  sealComposition,
} from '../plan/composition'
import { dbSurface, type RowRecord, rowById, surfaceOfDb } from '../plan/records'
import { hubCoverage, loadState, type PlanState } from '../plan/state'
import { dayView, rowView, viewContext, weekView } from '../plan/views'
import {
  accountId,
  checkAssignee,
  confirmMark,
  insertRow,
  isRefusal,
  logRow,
  planWrite,
  refuse,
  removeMark,
  resolveRow,
  ruleRefusal,
  setMark,
  standingConfirmations,
  surfaceId,
} from '../plan/writes'
import type { Services } from '../services'
import { integrationViews } from './integrations'
import { assertNotSent, cancelWithRow } from './plan-publish'

/**
 * The plan (DESIGN §4.11–4.13, SPEC §4, §5, §7): day and week, rows and their marks, manual
 * confirmations, cancellations, releases; the rules of «В план» are the server's — a person
 * and an agent meet the same checks (PLAN preamble). «Сверить» is stage 5.
 */

/** A just-created row may be deleted by its author within 6 s (SPEC §5, DESIGN §3.8). */
export const UNDO_WINDOW_MS = 6_000

export function planHandlers(services: Services): HandlerRegistry {
  const { db, command } = services

  const integrations = (q: Queryable, model: ModelScope) =>
    integrationViews(q, services, [model.code])

  async function views(
    q: Queryable,
    state: PlanState,
    rows: readonly RowRecord[],
    preview = false,
  ) {
    const context = await viewContext(q, state, await integrations(q, state.model), rows)
    const out: PlanRow[] = []
    for (const row of rows) out.push(await rowView(context, row, preview ? 'preview' : 'row'))
    return out
  }

  /** The row as the screen sees it after a command: state re-read inside the transaction. */
  async function rowAnswer(tx: Queryable, model: ModelScope, id: string): Promise<PlanRow> {
    const state = await loadState(tx, model)
    const row = state.rows.find((candidate) => candidate.id === id)
    if (!row) throw new ApiProblem('not_found', 'Такой строки плана нет')
    const [view] = await views(tx, state, [row])
    return view as PlanRow
  }

  function assertOpen(row: RowRecord) {
    if (row.cancelled_at) throw new ApiProblem('row_cancelled', 'Не выполнено: строка отменена')
  }

  function assertShips(row: RowRecord) {
    if (!row.manifest_id) {
      throw new ApiProblem('invalid_request', 'Строка ждёт файл — отмечать нечего', {
        row: row.id,
      })
    }
  }

  /** Before stage 5 every page and surface but Fansly stories and mass messages confirms by hand. */
  function confirmable(state: PlanState, row: RowRecord): boolean {
    return (
      markButtonKind(
        row.platform,
        surfaceOfDb(row.surface),
        hubCoverage(state, row.account).state,
      ) === 'mark_confirm'
    )
  }

  /**
   * Puts the rows all or nothing (§3.3): every refusal is reported with its index; a dry run
   * writes inside a savepoint and rolls it back, answering the preview of the rows.
   */
  async function createRows(
    tx: Tx,
    actor: Actor,
    model: ModelScope,
    inputs: readonly NewPlanRow[],
    dryRun: boolean,
    options: { unknownTime?: boolean } = {},
  ) {
    const state = await loadState(tx, model)
    const rejected: { index: number; code: string; text: string }[] = []
    const resolved = []
    for (const [index, input] of inputs.entries()) {
      const one = await resolveRow(tx, model, input)
      const refusal = isRefusal(one) ? one : ruleRefusal(state, one)
      if (refusal) rejected.push({ index, code: refusal.code, text: refusal.text })
      else if (!isRefusal(one)) resolved.push(one)
    }
    for (const input of inputs) await checkAssignee(tx, model, input.assignee)
    if (rejected.length > 0) return { created: false, rows: [], rejected }
    if (dryRun) await tx.execute(sql`SAVEPOINT plan_dry_run`)
    const ids: string[] = []
    for (const one of resolved) ids.push(await insertRow(tx, state, actor, one, options))
    const after = await loadState(tx, model)
    const rows = ids.map((id) => after.rows.find((row) => row.id === id) as RowRecord)
    const answer = await views(tx, after, rows, dryRun)
    if (dryRun) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT plan_dry_run`)
      return { created: false, rows: answer, rejected: [] }
    }
    for (const row of rows) await logRow(tx, after, row)
    return { created: true, rows: answer, rejected: [] }
  }

  async function markOne(
    tx: Tx,
    actor: Actor,
    model: ModelScope,
    id: string,
    kind: 'posted' | 'scheduled',
    statedAt: string | null,
  ) {
    const row = await rowById(tx, model, id, true)
    assertOpen(row)
    assertShips(row)
    if (row.mark_kind === kind)
      throw new ApiProblem('row_marked', 'Не выполнено: строка уже отмечена')
    if (kind === 'scheduled' && row.surface !== 'wall' && row.surface !== 'fyp') {
      throw new ApiProblem('invalid_request', '«в планировщике» — только у стены и фупа')
    }
    const stated = row.surface === 'story' || row.surface === 'mass_dm' ? statedAt : null
    const marked = await setMark(tx, model, row, actor, kind, stated)
    const state = await loadState(tx, model)
    await logRow(tx, state, marked, {
      Отметка: kind === 'scheduled' ? 'в планировщике' : 'выложено',
    })
    return marked
  }

  async function confirmOne(
    tx: Tx,
    actor: Actor,
    model: ModelScope,
    id: string,
    statedAt: string | null,
  ) {
    const row = await rowById(tx, model, id, true)
    assertOpen(row)
    assertShips(row)
    const state = await loadState(tx, model)
    if (!confirmable(state, row)) {
      throw new ApiProblem(
        'invalid_request',
        'Здесь «Отметить и подтвердить» нет: сториз и рассылка Fansly отмечаются «Отметить»',
      )
    }
    if ((await standingConfirmations(tx, model, row.id)).length > 0) {
      throw new ApiProblem('row_marked', 'Не выполнено: строка уже подтверждена')
    }
    const stated = row.surface === 'story' || row.surface === 'mass_dm' ? statedAt : null
    const confirmed = await confirmMark(tx, model, row, actor, stated)
    await logRow(tx, state, confirmed, { Подтверждение: 'отчёт о выполнении' })
    return confirmed
  }

  return {
    plan: {
      day: async ({ query, ctx }) => {
        const model = modelOf(ctx.model)
        const actor = requireActor(ctx)
        const state = await loadState(db, model)
        const context = await viewContext(db, state, await integrations(db, model))
        return dayView(context, query.date, query.mine ? actor.id : null, query.cancelled ?? false)
      },

      week: async ({ query, ctx }) => {
        const model = modelOf(ctx.model)
        const state = await loadState(db, model)
        const context = await viewContext(db, state, await integrations(db, model))
        return weekView(context, query.week)
      },

      row: async ({ params, ctx }) => {
        const model = modelOf(ctx.model)
        await rowById(db, model, params.row)
        return rowAnswer(db, model, params.row)
      },

      checkRow: async ({ body, ctx }) => {
        const model = modelOf(ctx.model)
        return db.transaction(async (tx) => {
          const state = await loadState(tx, model)
          const one = await resolveRow(tx, model, body)
          if (isRefusal(one)) {
            return {
              tone: 'attention' as const,
              text: one.text,
              page_text: one.text,
              blocked: true,
              warnings: [],
              question: null,
            }
          }
          const extra = ruleRefusal(state, one)
          if (extra && !extra.question && extra.code === 'invalid_request') {
            return {
              tone: 'attention' as const,
              text: extra.text.charAt(0).toUpperCase() + extra.text.slice(1),
              page_text: extra.text,
              blocked: true,
              warnings: [],
              question: null,
            }
          }
          return checkLine(state, one.candidate)
        })
      },

      createRows: ({ body, query, ctx }) =>
        command({ ctx, body }, (tx, actor) =>
          createRows(tx, actor, modelOf(ctx.model), body.rows, query.dry_run ?? false),
        ),

      undoCreate: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await rowById(tx, model, params.row, true)
          const age = Date.now() - Date.parse(row.created_at)
          const { rows: issued } = await tx.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM download_receipts
             WHERE model_id = ${model.id}::uuid AND plan_row_id = ${row.id}::uuid`)
          const { rows: placed } = await tx.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM placements
             WHERE model_id = ${model.id}::uuid AND plan_row_id = ${row.id}::uuid`)
          if (
            row.created_by !== actor.id ||
            age > UNDO_WINDOW_MS ||
            row.marked_at ||
            (issued[0]?.n ?? 0) > 0 ||
            (placed[0]?.n ?? 0) > 0
          ) {
            throw new ApiProblem('undo_expired', 'Строку уже нельзя удалить — её можно отменить')
          }
          const state = await loadState(tx, model)
          await logRow(tx, state, row, { Удалена: 'в течение 6 с' })
          await tx.execute(sql`
            DELETE FROM posting_plan_rows WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
          if (row.release_id) {
            await tx.execute(sql`
              DELETE FROM ppv_releases r
               WHERE r.model_id = ${model.id}::uuid AND r.id = ${row.release_id}::uuid
                 AND NOT EXISTS (SELECT 1 FROM posting_plan_rows p
                                  WHERE p.model_id = r.model_id AND p.release_id = r.id)`)
          }
          return { ok: true as const }
        }),

      updateRow: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await rowById(tx, model, params.row, true)
          await checkVersion(
            tx,
            ctx,
            {
              version: row.row_version,
              subjectKind: 'posting_plan_rows',
              subjectId: row.id,
              field: 'строка плана',
            },
            () => null,
          )
          const after: Record<string, unknown> = {}
          // A sent publication holds what it was made of (5б).
          if (
            body.replace_manifest ||
            body.caption !== undefined ||
            body.tiers !== undefined ||
            body.price_mills !== undefined ||
            body.repost !== undefined ||
            body.album !== undefined
          ) {
            assertNotSent(row)
          }
          if (body.assignee !== undefined) {
            await checkAssignee(tx, model, body.assignee)
            after.Исполнитель = body.assignee ?? 'по странице'
          }
          let manifestId = row.manifest_id
          if (body.replace_manifest) {
            assertOpen(row)
            if (!row.item_id || !row.item_type) {
              throw new ApiProblem(
                'invalid_request',
                'Строка ждёт монтаж: состав подставится с ним',
              )
            }
            const files = compositionOf(
              row.item_type,
              row.surface,
              await currentFiles(tx, model.id, row.item_id),
              row.uniq_variant_no,
            )
            if (files.length === 0) throw new ApiProblem('invalid_request', 'Нового состава нет')
            manifestId = await sealComposition(tx, model.id, row.item_id, files, actor.id)
            after.Состав = 'заменён'
          }
          await planWrite(() =>
            tx.execute(sql`
              UPDATE posting_plan_rows SET
                note = ${body.note === undefined ? sql`note` : body.note},
                assignee_id = ${body.assignee === undefined ? sql`assignee_id` : sql`${body.assignee}::uuid`},
                manifest_id = ${manifestId}::uuid,
                caption = ${body.caption === undefined ? sql`caption` : body.caption},
                tier_refs = ${body.tiers === undefined ? sql`tier_refs` : sql`${body.tiers === null ? null : sql.param(body.tiers)}::text[]`},
                price_mills = ${body.price_mills === undefined ? sql`price_mills` : body.price_mills},
                repost = ${body.repost === undefined ? sql`repost` : body.repost},
                album_name = ${body.album === undefined ? sql`album_name` : body.album},
                row_version = row_version + 1
               WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`),
          )
          const state = await loadState(tx, model)
          await logRow(tx, state, row, Object.keys(after).length > 0 ? after : undefined)
          return rowAnswer(tx, model, row.id)
        }),

      mark: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          await markOne(tx, actor, model, params.row, body.kind, body.stated_occurred_at)
          return rowAnswer(tx, model, params.row)
        }),

      markConfirm: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          await confirmOne(tx, actor, model, params.row, body.stated_occurred_at)
          return rowAnswer(tx, model, params.row)
        }),

      unmark: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await rowById(tx, model, params.row, true)
          if (!row.marked_at)
            throw new ApiProblem('row_not_marked', 'Не выполнено: строка не отмечена')
          if (row.marked_by !== actor.id && actor.role !== 'owner') {
            throw new ApiProblem('forbidden', 'Снять отметку может тот, кто отметил, и владелец')
          }
          await removeMark(tx, model, row, actor)
          const state = await loadState(tx, model)
          await logRow(tx, state, row, { Отметка: 'снята' })
          return rowAnswer(tx, model, row.id)
        }),

      cancel: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await rowById(tx, model, params.row, true)
          // The reason is picked after the cancellation (DESIGN §3.8): a repeat with a reason
          // only names it.
          if (row.cancelled_at && body.reason !== null) {
            await tx.execute(sql`
              UPDATE posting_plan_rows SET cancel_reason = ${body.reason}, row_version = row_version + 1
               WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
            return rowAnswer(tx, model, row.id)
          }
          assertOpen(row)
          if (row.marked_at)
            throw new ApiProblem('row_marked', 'Не выполнено: сначала снимите отметку')
          // A publication still in Hub's hands goes with the row (DESIGN §4.11).
          await cancelWithRow(tx, model, row, actor, ctx.requestId)
          await tx.execute(sql`
            UPDATE posting_plan_rows
               SET cancelled_at = now(), cancelled_by = nullif(current_setting('app.actor_id'), '')::uuid,
                   cancel_reason = ${body.reason}, row_version = row_version + 1
             WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
          const state = await loadState(tx, model)
          await logRow(tx, state, row, { Отменена: body.reason ?? 'без причины' })
          return rowAnswer(tx, model, row.id)
        }),

      move: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx.model)
          const row = await rowById(tx, model, params.row, true)
          await checkVersion(
            tx,
            ctx,
            {
              version: row.row_version,
              subjectKind: 'posting_plan_rows',
              subjectId: row.id,
              field: 'слот строки',
            },
            () => ({ date: row.slot_date, time: row.slot_time, account: row.account }),
          )
          assertOpen(row)
          if (row.marked_at) {
            throw new ApiProblem(
              'row_marked',
              'Отмеченную строку перенести нельзя — сначала снимите отметку',
            )
          }
          assertNotSent(row)
          const target = await accountId(tx, model, body.account)
          const state = await loadState(tx, model)
          if (body.account !== row.account) {
            const refusal = ruleRefusal(state, {
              input: {} as NewPlanRow,
              item: null,
              montage: null,
              accountId: target,
              candidate: {
                row_id: row.id,
                item:
                  row.item_id && row.item_type && row.item_number !== null
                    ? {
                        id: row.item_id,
                        type: row.item_type,
                        number: row.item_number,
                        has_second_person: row.has_second_person,
                      }
                    : null,
                montage_from: row.input_item_id ? { id: row.input_item_id } : null,
                account: body.account,
                surface: row.surface,
                date: body.date,
                time: body.time,
                release_id: row.release_id,
                marked: false,
              },
            })
            if (refusal) refuse(refusal)
          }
          const surface = await surfaceId(tx, model, target, row.surface)
          await planWrite(() =>
            tx.execute(sql`
              UPDATE posting_plan_rows
                 SET slot_date = ${body.date}::date, slot_time = ${body.time}::time,
                     account_id = ${target}::uuid, surface_id = ${surface}::uuid,
                     row_version = row_version + 1
               WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`),
          )
          await logRow(tx, state, row, {
            Слот: `${body.date}${body.time ? ` ${body.time}` : ''} · ${body.account}`,
          })
          return rowAnswer(tx, model, row.id)
        }),

      markMany: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const results: BatchResult['results'] = []
          for (const id of [...new Set(body.row_ids)]) {
            results.push(
              await batchOne(tx, id, () => markOne(tx, actor, model, id, body.kind, null)),
            )
          }
          return { results }
        }),

      markConfirmMany: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const results: BatchResult['results'] = []
          for (const id of [...new Set(body.row_ids)]) {
            results.push(await batchOne(tx, id, () => confirmOne(tx, actor, model, id, null)))
          }
          return { results }
        }),

      download: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const state = await loadState(tx, model)
          const inScope = (row: RowRecord) => {
            if (row.cancelled_at || !row.manifest_id || !row.item_id) return false
            if (body.account && row.account !== body.account) return false
            if (body.mine && row.executor_id !== actor.id) return false
            if (body.scope === 'release') return row.release_id === body.release_id
            // A day or a week: the rows that still need a step (DESIGN §4.11).
            if (row.marked_at) return false
            if (body.scope === 'day') return row.slot_date === body.date
            return isoWeekOf(row.slot_date) === body.week
          }
          const rows = state.rows.filter(inScope)
          if (rows.length === 0) {
            throw new ApiProblem('invalid_request', 'Нечего скачать: строк с файлами нет')
          }
          const digests = (await currentDigests(tx)) ?? {
            version: '',
            platform: '',
            platformStripped: '',
          }
          const parts: StoredBatch['parts'] = []
          for (const row of rows) {
            if (!row.item_type || row.item_number === null || !row.manifest_id || !row.item_id) {
              continue
            }
            const files = await manifestFiles(tx, model.id, row.manifest_id)
            if (files.some((file) => file.blob_state !== 'present')) {
              throw new ApiProblem(
                'unavailable',
                `${publicIdOf(row.item_type, row.item_number)}: байты файла недоступны`,
              )
            }
            const item = {
              id: row.item_id,
              type: row.item_type,
              public_id: publicIdOf(row.item_type, row.item_number),
              title: row.item_title,
              title_en: row.item_title_en,
            }
            const folder = body.scope === 'week' ? `${row.slot_date}/${row.account}` : row.account
            for (const key of rowFileKeys(row.item_type, row.surface)) {
              const plan = await planDownload(tx, {
                modelId: model.id,
                modelCode: model.code,
                item,
                files,
                kind: key,
                stripMetadata: body.strip_metadata,
                slot: { account: row.account, date: row.slot_date, time: row.slot_time },
                principalId: actor.id,
                digests,
                planRowId: row.id,
              })
              if (plan.files.length > 0) parts.push({ folder, plan })
            }
          }
          if (
            parts.some((part) => part.plan.files.some((file) => file.supply.kind === 'render')) &&
            digests.version === ''
          ) {
            throw new ApiProblem(
              'unavailable',
              'Медиаконвейер ещё не запускался: копии собирать некому',
            )
          }
          const first = parts[0]
          if (!first) throw new ApiProblem('invalid_request', 'Нечего скачать: у строк нет файлов')
          const tail = body.account ? `_${body.account}` : ''
          const when =
            body.scope === 'day'
              ? body.date
              : body.scope === 'week'
                ? body.week
                : `${first.plan.publicId}_${rows[0]?.release_date ?? ''}`
          const archive = `${model.code}_${body.scope}_${when}${tail}.zip`
          const { work } = await enqueueWork(tx, {
            modelId: model.id,
            kind: 'export',
            workKey: exportKeyOf(first.plan.receiptId),
            checkpoint: { batch: storedBatch({ scope: body.scope, archive, parts }) },
            priority: 1_000_000,
          })
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'plan',
            subjectLabel: archive,
            after: {
              rows: rows.length,
              files: parts.reduce((n, part) => n + part.plan.files.length, 0),
            },
          })
          return {
            kind: 'operation' as const,
            operation_id: work.id,
            status_url: `/api/v1/${model.code}/operations/${work.id}`,
          }
        }),

      createRelease: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const state = await loadState(tx, model)
          const inputs: NewPlanRow[] = body.cells.map((cell) => ({
            item_id: body.item_id,
            account: cell.account,
            surface: cell.surface,
            date: cell.date,
            time: cell.time,
            fyp_version: null,
            assignee: null,
            note: null,
            requires_new_upload: false,
            awaiting_montage: null,
            marked: null,
          }))
          const resolved = []
          const problems: { index: number; code: string; text: string }[] = []
          for (const [index, input] of inputs.entries()) {
            if (input.surface === 'fyp') {
              problems.push({ index, code: 'invalid_request', text: 'в выпуске нет фупа' })
              continue
            }
            const one = await resolveRow(tx, model, input, 'release')
            const refusal = isRefusal(one) ? one : ruleRefusal(state, one)
            if (refusal) problems.push({ index, code: refusal.code, text: refusal.text })
            else if (!isRefusal(one)) resolved.push(one)
          }
          const first = resolved[0]
          if (first && first.item?.type !== 'PPV') {
            throw new ApiProblem('invalid_request', 'Выпуск бывает только у PPV')
          }
          if (problems.length > 0 || !first?.item) {
            throw new ApiProblem(
              'batch_rejected',
              `Не поставлено: ${problems[0]?.text ?? 'нет строк'}`,
              {
                problems,
              },
            )
          }
          const item = first.item
          // One release per page; its date is the day it comes out: the wall or the mass message
          // (an earlier vault upload is no release of its own).
          const pages = [...new Set(resolved.map((one) => one.accountId))]
          const releaseOf = new Map<string, string>()
          for (const page of pages) {
            const cells = resolved.filter((one) => one.accountId === page)
            const main =
              cells.find((one) => one.input.surface === 'wall') ??
              cells.find((one) => one.input.surface === 'dm') ??
              [...cells].sort((a, b) => a.input.date.localeCompare(b.input.date))[0]
            const { rows } = await tx.execute<{ id: string }>(sql`
              INSERT INTO ppv_releases (model_id, account_id, item_id, release_date, created_by)
              VALUES (${model.id}::uuid, ${page}::uuid, ${item.id}::uuid, ${main?.input.date}::date,
                      ${actor.id}::uuid)
              RETURNING id`)
            releaseOf.set(page, rows[0]?.id as string)
          }
          const ids: string[] = []
          for (const one of resolved) {
            const releaseId = releaseOf.get(one.accountId) as string
            one.candidate.release_id = releaseId
            ids.push(await insertRow(tx, state, actor, one, { releaseId }))
          }
          const after = await loadState(tx, model)
          const rows = ids.map((id) => after.rows.find((row) => row.id === id) as RowRecord)
          for (const row of rows) await logRow(tx, after, row, { Выпуск: 'PPV' })
          const answer = await views(tx, after, rows)
          const releases: Release[] = [...releaseOf.values()].map((id) => {
            const own = rows.filter((row) => row.release_id === id)
            return {
              id,
              item_id: body.item_id,
              date: own[0]?.release_date ?? own[0]?.slot_date ?? body.cells[0]?.date ?? '',
              row_ids: own.map((row) => row.id),
              done: 0,
              accounts: 1,
            }
          })
          const head = releases[0] as Release
          return {
            release: {
              ...head,
              row_ids: rows.map((row) => row.id),
              accounts: releases.length,
            },
            rows: answer,
            releases,
          }
        }),
    },
  }

  /** One record of a batch «по каждой записи»: a refusal stays its own result (§3.3). */
  async function batchOne(
    tx: Tx,
    id: string,
    run: () => Promise<unknown>,
  ): Promise<BatchResult['results'][number]> {
    if (!isUuid(id)) return { id, ok: false, code: 'not_found' }
    await tx.execute(sql`SAVEPOINT plan_batch_one`)
    try {
      await run()
      await tx.execute(sql`RELEASE SAVEPOINT plan_batch_one`)
      return { id, ok: true, code: null }
    } catch (error) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT plan_batch_one`)
      if (error instanceof ApiProblem) return { id, ok: false, code: error.code }
      throw error
    }
  }
}

export type { RequestContext }
export { dbSurface }
