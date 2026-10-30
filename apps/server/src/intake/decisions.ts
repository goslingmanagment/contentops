import type { DecideCommand, UpdateDraftFilesCommand } from '@contentops/contracts/commands/inbox'
import type { FileRole } from '@contentops/contracts/domain/files'
import { enqueueWork, type Tx, type values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { lockOrder } from '../orders/writes'
import { acceptGroup, lockGroupForDecision, lockOpenDrafts, rejectGroup } from './accept'
import { queueMedia } from './fetch'
import { bindFrame, ordinalOfHandle, rawFrame } from './frames'
import { ITEM_TO_DB_TYPE } from './inbox-view'
import { planRow } from './row-upload'
import { acceptRowMontage } from './upload'

/**
 * The other decisions of «Приехало» (DESIGN §4.8, schema §3.4): merge and split of groups
 * before acceptance, the answers to ◆, roles and order of the files, and «Повторить» after ▲.
 * A group is a proposal with evidence: it changes freely until something is accepted from it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A new manual group of the same source with the fields of `fromId`. */
async function newManualGroup(
  tx: Tx,
  model: ModelScope,
  fromId: string,
  overrides: { type?: values.ContentType | null; purpose?: values.RawPurpose | null } = {},
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_groups (
      model_id, source_id, group_key, grouping, folder_object_id, evidence, proposed_type,
      proposed_title, proposed_title_en, proposed_description, proposed_tags, proposed_ppv_kind,
      proposed_purpose, has_second_person
    )
    SELECT model_id, source_id, 'split:' || uuidv7()::text, 'manual', folder_object_id,
           coalesce(evidence, '{}'::jsonb) || jsonb_build_object('split_from', id::text),
           ${overrides.type === undefined ? sql`proposed_type` : sql`${overrides.type}`},
           proposed_title, proposed_title_en, proposed_description, proposed_tags,
           proposed_ppv_kind,
           ${overrides.purpose === undefined ? sql`proposed_purpose` : sql`${overrides.purpose}`},
           has_second_person
      FROM inbox_groups WHERE model_id = ${model.id}::uuid AND id = ${fromId}::uuid
    RETURNING id`)
  const id = rows[0]?.id
  if (!id) throw new ApiProblem('not_found', 'Такой группы нет')
  return id
}

async function moveDrafts(tx: Tx, model: ModelScope, ids: readonly string[], groupId: string) {
  await tx.execute(sql`
    UPDATE inbox_drafts SET group_id = ${groupId}::uuid, updated_at = now(),
           row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ANY (${sql.param([...ids])}::uuid[])
       AND state <> 'resolved'`)
}

async function bump(tx: Tx, model: ModelScope, groupId: string) {
  await tx.execute(sql`
    UPDATE inbox_groups SET updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
}

/** «Разделить»: the chosen files become a group of their own; returns its id. */
export async function splitGroup(
  tx: Tx,
  model: ModelScope,
  groupId: string,
  keys: readonly string[],
): Promise<string> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  const chosen = drafts.filter((draft) => keys.includes(draft.id))
  if (chosen.length !== new Set(keys).size) {
    throw new ApiProblem('invalid_request', 'Таких файлов в группе нет', { file_keys: keys })
  }
  if (chosen.length === drafts.length) {
    throw new ApiProblem('invalid_request', 'Все файлы сразу не выделяются — группа опустеет')
  }
  const created = await newManualGroup(tx, model, groupId)
  await moveDrafts(
    tx,
    model,
    chosen.map((draft) => draft.id),
    created,
  )
  await bump(tx, model, groupId)
  return created
}

/** «Слить»: the open files of the other groups join the first one. */
export async function mergeGroups(
  tx: Tx,
  model: ModelScope,
  groupIds: readonly string[],
): Promise<string> {
  const ids = [...new Set(groupIds)]
  if (ids.length < 2 || ids.some((id) => !UUID.test(id))) {
    throw new ApiProblem('invalid_request', 'Нужно две группы или больше')
  }
  // Locks in id order: two merges never deadlock.
  for (const id of [...ids].sort()) await lockGroupForDecision(tx, model, id)
  const [into, ...rest] = ids as [string, ...string[]]
  for (const id of rest) {
    const drafts = await lockOpenDrafts(tx, model, id)
    await moveDrafts(
      tx,
      model,
      drafts.map((draft) => draft.id),
      into,
    )
    await bump(tx, model, id)
  }
  await bump(tx, model, into)
  return into
}

const DB_ROLE: Record<FileRole, values.AssetRole | null> = {
  master: 'master',
  teaser: 'teaser',
  photo: 'pic',
  clip: 'clip',
  raw: 'raw',
  montage: 'master',
  source: 'raw',
  promo_link: null,
}

/** Roles and order of the files: the proposal the accept follows when it fits the type. */
export async function updateFiles(
  tx: Tx,
  model: ModelScope,
  groupId: string,
  body: UpdateDraftFilesCommand,
): Promise<void> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  const known = new Set(drafts.map((draft) => draft.id))
  const unknown = [...(body.roles ?? []).map((row) => row.key), ...(body.order ?? [])].filter(
    (key) => !known.has(key),
  )
  if (unknown.length > 0)
    throw new ApiProblem('invalid_request', 'Таких файлов в группе нет', { keys: unknown })
  for (const { key, role } of body.roles ?? []) {
    await tx.execute(sql`
      UPDATE inbox_drafts SET proposed_role = ${DB_ROLE[role]}, updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${key}::uuid`)
  }
  for (const [index, key] of (body.order ?? []).entries()) {
    await tx.execute(sql`
      UPDATE inbox_drafts SET proposed_ordinal = ${index + 1}, updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${key}::uuid`)
  }
  await bump(tx, model, groupId)
}

/** Answers to ◆ «нужно решение». */
export async function decide(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  groupId: string,
  body: DecideCommand,
): Promise<void> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  const ids = drafts.map((draft) => draft.id)
  const clear = async (reason: values.DraftBlockedReason) => {
    await tx.execute(sql`
      UPDATE inbox_drafts SET blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ANY (${sql.param(ids)}::uuid[])
         AND blocked_reason = ${reason}`)
  }
  switch (body.decision) {
    case 'what_is_it':
      await tx.execute(sql`
        UPDATE inbox_groups SET proposed_type = ${ITEM_TO_DB_TYPE[body.type]}
         WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
      await clear('needs_type')
      break
    case 'which_order': {
      // The order by its address (`tg-…`, as the orders API gives it) or its stored id; an
      // unknown one is 404, never a failed cast.
      const orderId = body.order_id === null ? null : (await lockOrder(tx, model, body.order_id)).id
      await tx.execute(sql`
        UPDATE inbox_groups SET custom_order_id = ${orderId}::uuid,
               proposed_type = CASE WHEN ${orderId}::uuid IS NULL THEN proposed_type ELSE 'CUS' END
         WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
      if (orderId) {
        await tx.execute(sql`
          UPDATE inbox_draft_candidates SET chosen = true, chosen_at = now(), chosen_by = ${actor.id}::uuid
           WHERE model_id = ${model.id}::uuid AND draft_id = ANY (${sql.param(ids)}::uuid[])
             AND kind = 'order' AND order_id = ${orderId}::uuid AND NOT chosen`)
      }
      await clear('ambiguous_order')
      break
    }
    case 'video_in_set': {
      const videos = drafts.filter((draft) => draft.media_kind === 'video').map((draft) => draft.id)
      if (videos.length === 0) throw new ApiProblem('invalid_request', 'Видео в группе нет')
      if (body.destination === 'reject') {
        const split = await newManualGroup(tx, model, groupId)
        await moveDrafts(tx, model, videos, split)
        await rejectGroup(tx, model, actor, split, 'видео среди фото')
      } else {
        const type = { raw: 'RAW', life: 'LIFE', fyp_source: 'RAW', separate: null } as const
        await moveDrafts(
          tx,
          model,
          videos,
          await newManualGroup(tx, model, groupId, {
            type: type[body.destination],
            purpose:
              body.destination === 'fyp_source'
                ? 'fyp'
                : body.destination === 'raw'
                  ? 'unknown'
                  : null,
          }),
        )
      }
      await clear('video_in_set')
      break
    }
    case 'cross_model':
      if (!body.keep) {
        await rejectGroup(tx, model, actor, groupId, 'такой файл есть у другой модели')
      } else {
        await clear('cross_model_dup')
      }
      await tx.execute(sql`
        UPDATE review_cases
           SET state = ${body.keep ? 'resolved' : 'dismissed'}, resolved_at = now(),
               resolved_by = ${actor.id}::uuid, resolution = ${JSON.stringify({ keep: body.keep })}::jsonb,
               row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND kind = 'cross_model_duplicate' AND state = 'open'
           AND draft_id = ANY (${sql.param(ids)}::uuid[])`)
      break
    case 'number_taken': {
      // «Номер занят» (SPEC §6.4): an old number another folder holds. Keep — the block lifts
      // and the object takes the next number of the counter; no — the group is refused.
      const disputed = drafts.filter((draft) => draft.blocked_reason === 'id_collision')
      if (disputed.length === 0) {
        throw new ApiProblem('accept_blocked', 'В этой группе нет спора о номере', {
          reason: 'no_dispute',
        })
      }
      if (body.keep) await clear('id_collision')
      else await rejectGroup(tx, model, actor, groupId, 'номер занят другой папкой')
      break
    }
    case 'which_frame': {
      const draft = drafts.find(
        (candidate) => candidate.id === body.file_key && candidate.blocked_reason === 'which_frame',
      )
      if (!draft?.target_item_id) {
        throw new ApiProblem('accept_blocked', 'У этого файла нет вопроса «К какому кадру?»', {
          reason: 'no_frame_question',
        })
      }
      const ordinal = ordinalOfHandle(body.frame)
      if (!(await rawFrame(tx, model.id, draft.target_item_id, ordinal))) {
        throw new ApiProblem('invalid_request', 'Такого кадра в сете нет', { frame: body.frame })
      }
      await bindFrame(tx, model.id, draft.id, ordinal)
      // The last answer accepts the files into the set, as the upload itself would have.
      const open = drafts.filter((other) => other.id !== draft.id && other.blocked_reason)
      if (open.length === 0) {
        const { rows } = await tx.execute<{ public_id: string }>(sql`
          SELECT public_item_id(type, number) AS public_id FROM content_items
           WHERE model_id = ${model.id}::uuid AND id = ${draft.target_item_id}::uuid`)
        await acceptGroup(tx, model, actor, groupId, {
          as: 'default',
          how: 'upload',
          role: 'ed',
          extend: { item_id: rows[0]?.public_id as string, role: 'photos' },
        })
      }
      break
    }
    case 'substitute_montage': {
      // ◆ «Подставить монтаж в строку?» (SPEC §7): the montage was uploaded for a row that no
      // longer waits; the answer accepts it and puts it into the row, or keeps it in the catalog.
      const waiting = drafts.filter((draft) => draft.blocked_reason === 'row_changed')
      const { rows: evidence } = await tx.execute<{ row_id: string | null }>(sql`
        SELECT evidence ->> 'plan_row_id' AS row_id FROM inbox_groups
         WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
      const rowId = evidence[0]?.row_id
      if (waiting.length === 0 || !rowId) {
        throw new ApiProblem('accept_blocked', 'В этой группе нет монтажа для строки плана', {
          reason: 'no_plan_row',
        })
      }
      await clear('row_changed')
      const row = await planRow(tx, model, rowId, true)
      await acceptRowMontage(tx, model, actor, groupId, row, body.substitute)
      break
    }
    case 'split_archive':
      // Archives are unpacked once by the import (SPEC §6.3, stage 3); intake keeps the archive
      // as a fact of the source and offers no draft for it, so there is nothing to split here.
      throw new ApiProblem(
        'accept_blocked',
        'Архивы распаковывает импорт старого Я.Диска (этап 3): в этой группе архива нет',
        { reason: 'no_archive' },
      )
  }
  await bump(tx, model, groupId)
}

/** «Повторить» after ▲: the fetch or the master of the failed drafts again. */
export async function retryGroup(tx: Tx, model: ModelScope, groupId: string): Promise<number> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  let queued = 0
  for (const draft of drafts) {
    const failedMaster = draft.blocked_reason === 'master_failed'
    const vanished = draft.blocked_reason === 'source_unavailable'
    if (!failedMaster && !vanished) continue
    const attempt = `retry-${Date.now()}`
    await tx.execute(sql`
      UPDATE inbox_drafts SET blocked_reason = NULL, error = NULL, updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${draft.id}::uuid`)
    if (failedMaster && draft.source_hex) {
      await queueMedia(
        tx,
        model.id,
        draft.id,
        draft.source_hex,
        draft.media_kind ?? 'video',
        null,
        attempt,
      )
    } else if (draft.source_revision_id) {
      await enqueueWork(tx, {
        modelId: model.id,
        kind: 'fetch',
        workKey: `fetch:${draft.source_revision_id}:${attempt}`,
        sourceRevisionId: draft.source_revision_id,
        draftId: draft.id,
        priority: 50,
      })
    }
    queued += 1
  }
  if (queued === 0) throw new ApiProblem('invalid_request', 'Повторять нечего')
  await bump(tx, model, groupId)
  return queued
}
