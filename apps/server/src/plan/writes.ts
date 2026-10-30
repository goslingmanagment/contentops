import { randomUUID } from 'node:crypto'
import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import type { MarkKind } from '@contentops/contracts/domain/placement'
import { formatDate } from '@contentops/contracts/format'
import {
  dbErrorCode,
  enqueueWork,
  logAction,
  setJournalItem,
  type Tx,
  values,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import { findItem, type ItemRow, publicIdOfRow } from '../catalog/ids'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { FileRow } from '../media/downloads'
import { uniqKey } from '../media/work/copies'
import type { Candidate, Refusal } from './checks'
import { refusalOf } from './checks'
import {
  compositionOf,
  currentFiles,
  enqueueCopies,
  manifestFiles,
  sealComposition,
} from './composition'
import { type DbSurface, dbSurface, type RowRecord, rowById, surfaceOfDb } from './records'
import type { PlanState } from './state'

/**
 * Writes of the plan (SPEC §5, §7): rows with their sealed composition, marks and their
 * placements, manual confirmations and their retractions, cancellations. One command is one
 * transaction (`commands.ts`); refusals of the rules come before any write, the database
 * guards the rest (the second person, the slot, the release page).
 */

const SURFACE_LABEL: Record<DbSurface, string> = {
  wall: 'стена',
  fyp: 'фуп',
  story: 'сториз',
  vault: 'vault',
  mass_dm: 'рассылка',
}

/** «PPV-073 · Fansly 1 · стена 22.09» — the subject of the journal line. */
export function rowLabel(state: PlanState, row: RowRecord): string {
  const page = state.view.accounts.find((account) => account.code === row.account)
  const what =
    row.item_type && row.item_number !== null
      ? publicIdOfRow({ type: row.item_type, number: row.item_number })
      : 'строка под монтаж'
  const when = formatDate(row.slot_date, row.slot_date)
  return `${what} · ${page?.label ?? row.account} · ${SURFACE_LABEL[row.surface]} ${when}${row.slot_time ? ` ${row.slot_time}` : ''}`
}

/** Database refusals of a plan write as the API says them. */
export async function planWrite<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const code = dbErrorCode(error)
    if (code === values.dbErrorCodes.secondPersonOnOnlyFans) {
      const detail = (error as { detail?: string }).detail
      throw new ApiProblem(
        'second_person_onlyfans',
        detail === 'unchecked'
          ? 'Нельзя на OnlyFans: второго человека в кадре не проверяли'
          : 'Нельзя на OnlyFans: второй человек в кадре',
      )
    }
    if (code === values.dbErrorCodes.transitionRefused) {
      throw new ApiProblem('invalid_request', 'Строка выпуска остаётся на странице выпуска')
    }
    throw error
  }
}

export function refuse(refusal: Refusal): never {
  throw new ApiProblem(
    refusal.code,
    refusal.text,
    refusal.question ? { question: refusal.question } : undefined,
  )
}

export async function surfaceId(
  tx: Tx,
  model: ModelScope,
  accountId: string,
  kind: DbSurface,
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM surfaces
     WHERE model_id = ${model.id}::uuid AND account_id = ${accountId}::uuid AND kind = ${kind}`)
  const row = rows[0]
  if (!row) {
    throw new ApiProblem('invalid_request', `У страницы нет места «${SURFACE_LABEL[kind]}»`, {
      surface: surfaceOfDb(kind),
    })
  }
  return row.id
}

export async function accountId(tx: Tx, model: ModelScope, code: string): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM accounts
     WHERE model_id = ${model.id}::uuid AND code = ${code} AND archived_at IS NULL`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', `Страницы ${code} нет`, { account: code })
  return row.id
}

/** A person who may post for the model: the assignee of «Передать другому». */
export async function checkAssignee(tx: Tx, model: ModelScope, id: string | null): Promise<void> {
  if (id === null) return
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT true AS ok FROM principals p
     WHERE p.id::text = ${id} AND p.disabled_at IS NULL AND p.role IN ('owner', 'manager')
       AND (p.role = 'owner' OR EXISTS (
             SELECT 1 FROM principal_grants g
              WHERE g.principal_id = p.id AND g.model_id = ${model.id}::uuid
                AND g.revoked_at IS NULL))`)
  if (!rows[0]) {
    throw new ApiProblem('invalid_request', 'Такого человека нет у модели', { field: 'assignee' })
  }
}

/** What a new row is: the object, the raw of a montage, the page and surface. */
export interface ResolvedRow {
  input: NewPlanRow
  item: ItemRow | null
  montage: ItemRow | null
  accountId: string
  candidate: Candidate
}

export async function resolveRow(
  tx: Tx,
  model: ModelScope,
  input: NewPlanRow,
  releaseId: string | null = null,
): Promise<ResolvedRow | Refusal> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM accounts
     WHERE model_id = ${model.id}::uuid AND code = ${input.account} AND archived_at IS NULL`)
  const page = rows[0]
  if (!page) return { code: 'not_found', text: `Страницы ${input.account} нет` }
  const find = (id: string) =>
    findItem(tx, model, id).catch((error) => {
      if (error instanceof ApiProblem && error.code === 'not_found') return null
      throw error
    })
  const item = input.item_id ? await find(input.item_id) : null
  if (input.item_id && !item) return { code: 'not_found', text: `${input.item_id} нет` }
  const montage = input.awaiting_montage ? await find(input.awaiting_montage.from_item) : null
  if (input.awaiting_montage && !montage) {
    return { code: 'not_found', text: `${input.awaiting_montage.from_item} нет` }
  }
  return {
    input,
    item,
    montage,
    accountId: page.id,
    candidate: {
      row_id: null,
      item: item
        ? {
            id: item.id,
            type: item.type,
            number: item.number,
            has_second_person: item.has_second_person,
          }
        : null,
      montage_from: montage ? { id: montage.id } : null,
      account: input.account,
      surface: dbSurface(input.surface),
      date: input.date,
      time: input.time,
      release_id: releaseId,
      marked: input.marked !== null,
    },
  }
}

export function isRefusal(value: ResolvedRow | Refusal): value is Refusal {
  return 'code' in value
}

/** The refusal of a resolved row by the rules, if any. */
export function ruleRefusal(state: PlanState, resolved: ResolvedRow): Refusal | null {
  const refusal = refusalOf(state, resolved.candidate)
  if (refusal) return refusal
  const { input, item } = resolved
  if (input.fyp_version && item?.type !== 'FYP') {
    return { code: 'invalid_request', text: 'версии бывают только у фупа' }
  }
  if (input.marked === 'scheduled' && !['wall', 'fyp'].includes(dbSurface(input.surface))) {
    return { code: 'invalid_request', text: '«в планировщике» — только у стены и фупа' }
  }
  return null
}

const EXPECTED_TYPE: Record<'fyp' | 'ppv' | 'teaser', 'FYP' | 'PPV'> = {
  fyp: 'FYP',
  ppv: 'PPV',
  teaser: 'PPV',
}

interface InsertOptions {
  releaseId?: string | null
  releaseSurface?: DbSurface | null
  /** «Уже залито»: the time of the upload is unknown. */
  unknownTime?: boolean
}

/**
 * Inserts one row with its sealed composition (SPEC §7): the files the row ships at their
 * current versions; a FYP on another page ships its unique version, built now when missing; a
 * story of a release before its teaser waits for the teaser. The platform copy is enqueued.
 */
export async function insertRow(
  tx: Tx,
  state: PlanState,
  actor: Actor,
  resolved: ResolvedRow,
  options: InsertOptions = {},
): Promise<string> {
  const { input, item, montage } = resolved
  const model = state.model
  const surface = dbSurface(input.surface)
  const surfaceKey = await surfaceId(tx, model, resolved.accountId, surface)
  await setJournalItem(tx, item?.id ?? montage?.id ?? null)
  let manifestId: string | null = null
  let expectedType: 'FYP' | 'PPV' | null = null
  let expectedRole: 'teaser' | null = null
  let inputManifestId: string | null = null
  let uniq: number | null = null
  let composition: FileRow[] = []
  if (item) {
    uniq = input.fyp_version?.no ?? null
    const files = await currentFiles(tx, model.id, item.id)
    composition = compositionOf(item.type, surface, files, uniq)
    if (composition.length > 0) {
      manifestId = await sealComposition(tx, model.id, item.id, composition, actor.id)
    } else if (uniq !== null) {
      await requestVersion(tx, model, item, files, uniq, input.fyp_version?.level ?? 'soft')
    } else if (surface === 'story' && item.type === 'PPV') {
      expectedRole = 'teaser'
    } else {
      throw new ApiProblem(
        'invalid_request',
        `${publicIdOfRow(item)}: нечего ставить ${SURFACE_LABEL[surface] === 'vault' ? 'в vault' : `на «${SURFACE_LABEL[surface]}»`} — нет файлов`,
      )
    }
  } else if (montage && input.awaiting_montage) {
    const wanted = input.awaiting_montage
    expectedType = EXPECTED_TYPE[wanted.expected_type]
    expectedRole = wanted.expected_type === 'teaser' ? 'teaser' : null
    const sources = (await currentFiles(tx, model.id, montage.id)).filter((file) =>
      wanted.file_keys.includes(handle(file)),
    )
    if (sources.length === 0) {
      throw new ApiProblem('invalid_request', 'Не выбраны файлы съёмки', { field: 'file_keys' })
    }
    inputManifestId = await sealComposition(tx, model.id, montage.id, sources, actor.id)
  }
  const marked = input.marked
  const id = randomUUID()
  await planWrite(() =>
    tx.execute(sql`
      INSERT INTO posting_plan_rows (
        model_id, id, item_id, account_id, surface_id, slot_date, slot_time, assignee_id,
        release_id, release_surface_kind, manifest_id, expected_type, expected_role,
        input_manifest_id, uniq_variant_no, requires_new_upload, note,
        marked_by, marked_at, mark_kind, marked_manifest_id, created_by
      ) VALUES (
        ${model.id}::uuid, ${id}::uuid, ${item?.id ?? null}::uuid, ${resolved.accountId}::uuid,
        ${surfaceKey}::uuid, ${input.date}::date, ${input.time}::time, ${input.assignee}::uuid,
        ${options.releaseId ?? null}::uuid, ${options.releaseId ? (options.releaseSurface ?? surface) : null},
        ${manifestId}::uuid, ${expectedType}, ${expectedRole}, ${inputManifestId}::uuid, ${uniq},
        ${input.requires_new_upload}, ${input.note},
        ${marked ? actor.id : null}::uuid, ${marked ? sql`now()` : null}, ${marked},
        ${marked ? manifestId : null}::uuid, ${actor.id}::uuid
      )`),
  )
  if (marked) {
    if (!manifestId)
      throw new ApiProblem('invalid_request', 'Строку, которая ждёт файл, не отметить')
    const row = await rowById(tx, model, id)
    await markPlacement(tx, model, row, actor, null, options.unknownTime ?? false)
  }
  await enqueueCopies(tx, model.id, composition)
  return id
}

function handle(file: FileRow): string {
  if (file.variant_no > 0) return `u${file.variant_no}`
  return file.ordinal ? `${file.role}${String(file.ordinal).padStart(2, '0')}` : file.role
}

/** «Версии для Fansly 2, 3»: a version that is not built yet is built from the montage now. */
async function requestVersion(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  files: readonly FileRow[],
  n: number,
  level: 'soft' | 'trim' | 'mirror',
): Promise<void> {
  const base = files.find((file) => file.role === 'master' && file.variant_no === 0)
  if (!base) throw new ApiProblem('invalid_request', `${publicIdOfRow(item)}: у фупа нет монтажа`)
  if (n > 10)
    throw new ApiProblem('invalid_request', 'Больше десяти версий у одного фупа не собрать')
  await enqueueWork(tx, {
    modelId: model.id,
    kind: 'uniq_render',
    workKey: uniqKey(base.version_id, level, n),
    assetVersionId: base.version_id,
    priority: 500_000,
  })
}

/**
 * The placement of a KM mark (SPEC §5, §7): one per row and surface, without an external ID
 * (`manual_key = row:<id>`), with the files of the marked composition. A Hub observation found
 * later writes its IDs into the same placement (stage 5).
 */
export async function markPlacement(
  tx: Tx,
  model: ModelScope,
  row: RowRecord,
  actor: Actor,
  statedAt: string | null,
  unknownTime: boolean,
): Promise<string> {
  const posted = row.mark_kind === 'posted'
  const occurred = posted && !unknownTime ? (statedAt ?? new Date().toISOString()) : null
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO placements (model_id, account_id, surface_id, occurrence_kind, manual_key, item_id,
                            item_type, plan_row_id, planned_at, occurred_at, event_precision,
                            occurred_source, surface_source, origin, created_by)
    VALUES (${model.id}::uuid, ${row.account_id}::uuid, ${row.surface_id}::uuid, 'manual',
            ${`row:${row.id}`}, ${row.item_id}::uuid, ${row.item_type}, ${row.id}::uuid,
            ${row.slot_at}::timestamptz, ${occurred}::timestamptz,
            ${unknownTime ? 'unknown' : 'exact'}, ${occurred ? 'km' : null}, 'km_mark', 'plan',
            ${actor.id}::uuid)
    ON CONFLICT (model_id, surface_id, manual_key) WHERE manual_key IS NOT NULL
    DO UPDATE SET occurred_at = EXCLUDED.occurred_at, occurred_source = EXCLUDED.occurred_source,
                  event_precision = EXCLUDED.event_precision, planned_at = EXCLUDED.planned_at,
                  row_version = placements.row_version + 1
    RETURNING id`)
  const placementId = rows[0]?.id as string
  const files = row.manifest_id ? await manifestFiles(tx, model.id, row.manifest_id) : []
  await tx.execute(sql`
    DELETE FROM placement_assets
     WHERE model_id = ${model.id}::uuid AND placement_id = ${placementId}::uuid
       AND match_strength = 'none'`)
  for (const file of files) {
    await tx.execute(sql`
      INSERT INTO placement_assets (model_id, placement_id, asset_id, asset_version_id, position,
                                    bound_by)
      VALUES (${model.id}::uuid, ${placementId}::uuid, ${file.asset_id}::uuid,
              ${file.version_id}::uuid,
              (SELECT coalesce(max(position), 0) + 1 FROM placement_assets
                WHERE model_id = ${model.id}::uuid AND placement_id = ${placementId}::uuid),
              ${actor.id}::uuid)
      ON CONFLICT (model_id, placement_id, asset_version_id) DO NOTHING`)
  }
  return placementId
}

/** Sets the KM mark of a row: «выложено» or «в планировщике» (SPEC §5). */
export async function setMark(
  tx: Tx,
  model: ModelScope,
  row: RowRecord,
  actor: Actor,
  kind: MarkKind,
  statedAt: string | null,
): Promise<RowRecord> {
  await setJournalItem(tx, row.item_id)
  await tx.execute(sql`
    UPDATE posting_plan_rows
       SET marked_at = now(), marked_by = ${actor.id}::uuid, mark_kind = ${kind},
           marked_manifest_id = manifest_id, stated_occurred_at = ${statedAt}::timestamptz,
           row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  const marked = await rowById(tx, model, row.id)
  await markPlacement(tx, model, marked, actor, statedAt, false)
  return marked
}

/**
 * «Отметить и подтвердить» (SPEC §7): the mark and the manual confirmation in one transaction,
 * basis «отчёт о выполнении», never «подтверждено Hub».
 */
export async function confirmMark(
  tx: Tx,
  model: ModelScope,
  row: RowRecord,
  actor: Actor,
  statedAt: string | null,
): Promise<RowRecord> {
  const marked =
    row.marked_at && row.mark_kind === 'posted'
      ? row
      : await setMark(tx, model, row, actor, 'posted', statedAt)
  const placementId = await markPlacement(
    tx,
    model,
    marked,
    actor,
    statedAt ?? marked.stated_occurred_at,
    false,
  )
  await tx.execute(sql`
    INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength, payload,
                                    event_at, recorded_by, dedup_key)
    VALUES (${model.id}::uuid, ${placementId}::uuid, 'manual', 'manual_confirm', 'exact',
            ${JSON.stringify({ basis: 'execution_report', plan_row_id: row.id })}::jsonb,
            ${statedAt ?? marked.stated_occurred_at ?? marked.marked_at}::timestamptz,
            ${actor.id}::uuid, ${`manual:${randomUUID()}`})`)
  return rowById(tx, model, row.id)
}

/** Standing manual confirmations of the row's placements. */
export async function standingConfirmations(
  tx: Tx,
  model: ModelScope,
  rowId: string,
): Promise<{ id: string; placement_id: string }[]> {
  const { rows } = await tx.execute<{ id: string; placement_id: string }>(sql`
    SELECT e.id, e.placement_id FROM placement_evidence e
      JOIN placements p ON p.model_id = e.model_id AND p.id = e.placement_id
     WHERE e.model_id = ${model.id}::uuid AND p.plan_row_id = ${rowId}::uuid
       AND e.kind = 'manual_confirm'
       AND NOT EXISTS (SELECT 1 FROM placement_evidence r WHERE r.corrects_id = e.id)`)
  return rows
}

/**
 * «Снять отметку» (SPEC §5): the mark goes; a manual confirmation that came with it gets its
 * retraction in the same transaction; a placement that has no evidence left goes with the mark.
 */
export async function removeMark(
  tx: Tx,
  model: ModelScope,
  row: RowRecord,
  actor: Actor,
): Promise<void> {
  await setJournalItem(tx, row.item_id)
  for (const confirmation of await standingConfirmations(tx, model, row.id)) {
    await tx.execute(sql`
      INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength, payload,
                                      recorded_by, corrects_id, dedup_key)
      VALUES (${model.id}::uuid, ${confirmation.placement_id}::uuid, 'manual', 'retract', NULL,
              ${JSON.stringify({ plan_row_id: row.id })}::jsonb, ${actor.id}::uuid,
              ${confirmation.id}::uuid, ${`retract:${confirmation.id}`})`)
  }
  await tx.execute(sql`
    UPDATE posting_plan_rows
       SET marked_at = NULL, marked_by = NULL, mark_kind = NULL, marked_manifest_id = NULL,
           stated_occurred_at = NULL, row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  const { rows: bare } = await tx.execute<{ id: string }>(sql`
    SELECT p.id FROM placements p
     WHERE p.model_id = ${model.id}::uuid AND p.plan_row_id = ${row.id}::uuid
       AND p.manual_key = ${`row:${row.id}`}
       AND NOT EXISTS (SELECT 1 FROM placement_evidence e
                        WHERE e.model_id = p.model_id AND e.placement_id = p.id)`)
  for (const placement of bare) {
    await tx.execute(sql`
      DELETE FROM placement_assets
       WHERE model_id = ${model.id}::uuid AND placement_id = ${placement.id}::uuid`)
    await tx.execute(sql`
      DELETE FROM placements WHERE model_id = ${model.id}::uuid AND id = ${placement.id}::uuid`)
  }
}

export async function logRow(
  tx: Tx,
  state: PlanState,
  row: RowRecord,
  after?: Record<string, unknown>,
): Promise<void> {
  await logAction(tx, {
    modelId: state.model.id,
    subjectKind: 'posting_plan_rows',
    subjectId: row.id,
    itemId: row.item_id ?? row.input_item_id,
    subjectLabel: rowLabel(state, row),
    ...(after ? { after } : {}),
  })
}
